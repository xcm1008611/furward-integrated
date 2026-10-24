"""Real TCP integration test; uses ephemeral localhost ports, never live services."""
import asyncio
import json
import socket
import time

import httpx
import pytest
import uvicorn
import websockets

from demo_service.main import create_app


def test_real_tcp_blackhole_pauses_and_same_session_recovers():
    asyncio.run(blackhole_scenario())


async def blackhole_scenario():
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    port = listener.getsockname()[1]
    app = create_app()
    # Keep normal production transport settings. Our application lease must
    # detect the outage before Uvicorn's 20s ping / 20s ping timeout would.
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='error'))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    blackhole = False
    dropped = 0
    eof_at = []
    writers = []
    transfers = set()

    async def bridge(client_reader, client_writer):
        task = asyncio.current_task()
        transfers.add(task)
        upstream_reader, upstream_writer = await asyncio.open_connection('127.0.0.1', port)
        writers.extend((client_writer, upstream_writer))

        async def copy(reader, writer):
            nonlocal dropped
            while packet := await reader.read(65536):
                if blackhole:
                    # Discard without closing, aborting, or writing EOF to either peer.
                    dropped += len(packet)
                else:
                    writer.write(packet)
                    await writer.drain()
            eof_at.append(time.monotonic())

        try:
            await asyncio.gather(copy(client_reader, upstream_writer), copy(upstream_reader, client_writer))
        finally:
            transfers.discard(task)

    proxy_server = await asyncio.start_server(bridge, '127.0.0.1', 0)
    proxy_port = proxy_server.sockets[0].getsockname()[1]
    ws = None
    try:
        for _ in range(200):
            if server.started:
                break
            await asyncio.sleep(.01)
        assert server.started
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', trust_env=False) as client:
            identity = (await client.post('/api/demo/sessions')).json()['data']
            headers = {'Authorization': 'Bearer ' + identity['token']}
            path = '/api/demo/sessions/' + identity['session_id']
            ws = await websockets.connect(f'ws://127.0.0.1:{proxy_port}/ws/demo', proxy=None,
                                          ping_interval=None, close_timeout=.1)
            await ws.send(json.dumps({key: identity[key] for key in ('session_id', 'token')}))
            await ws.recv()
            await ws.send(json.dumps({'type': 'ping'}))
            assert json.loads(await ws.recv())['type'] == 'pong'
            last_ping = time.monotonic()
            await client.post(path + '/actions', headers=headers, json={'action': 'start'})
            blackhole = True
            print('\nTCP blackhole enabled: both directions discarded, no FIN/RST injected', flush=True)
            observed_lease_expiry = None
            while time.monotonic() - last_ping < 28:
                await asyncio.sleep(.2)
                state = (await client.get(path, headers=headers)).json()['data']
                session = app.state.registry.sessions[identity['session_id']]
                elapsed = time.monotonic() - last_ping
                if not session.subscribers and observed_lease_expiry is None:
                    observed_lease_expiry = elapsed
                    assert not eof_at, 'Socket transport closed before application lease expiry'
                    print(f'Application lease expired at {elapsed:.2f}s while TCP remained open', flush=True)
                if state['status'] == 'PAUSED':
                    break
            assert observed_lease_expiry is not None and 14.8 <= observed_lease_expiry < 16
            assert state['status'] == 'PAUSED' and state['pause_reason'] == 'disconnected'
            assert 24.8 <= elapsed < 27
            assert state['distance_m'] == pytest.approx(30, abs=.1)
            assert dropped > 0
            print(f'Paused at {elapsed:.2f}s / {state["distance_m"]:.3f}m from last valid ping', flush=True)

            # Reconnect directly with the same identity. Recovery must retain
            # the paused position until an explicit resume request arrives.
            async with websockets.connect(f'ws://127.0.0.1:{port}/ws/demo', proxy=None) as recovered:
                await recovered.send(json.dumps({key: identity[key] for key in ('session_id', 'token')}))
                snapshot = json.loads(await recovered.recv())['data']
                assert snapshot['status'] == 'PAUSED' and snapshot['distance_m'] == state['distance_m']
                await asyncio.sleep(.2)
                assert (await client.get(path, headers=headers)).json()['data']['status'] == 'PAUSED'
                resumed = (await client.post(path + '/actions', headers=headers, json={'action': 'resume'})).json()['data']
                assert resumed['status'] == 'ACTIVE'
            print('Same-session reconnect retained pause; explicit resume succeeded', flush=True)
    finally:
        proxy_server.close()
        for writer in writers:
            writer.close()
        await asyncio.wait_for(proxy_server.wait_closed(), 2)
        if ws is not None:
            await asyncio.wait_for(ws.close(), 2)
        owned_transfers = tuple(transfers)
        for task in owned_transfers:
            task.cancel()
        await asyncio.wait_for(asyncio.gather(*owned_transfers, return_exceptions=True), 2)
        server.should_exit = True
        await asyncio.wait_for(serving, 5)
        listener.close()
