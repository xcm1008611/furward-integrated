import pytest

from demo_service.detours import (
    ACTOR_CLEARANCE_M, distances, initial_navigation, obstacle_polygon,
    path_clearance, plan_detour, point_at,
)
from demo_service.engine import Config, DemoError, Registry, World
from demo_service.main import DEFAULT_WORLD
from test_demo import advance_connected, api_create, client, clock, create, registry, world_path


def begin_detour(registry, session, action='obstacle_bypass'):
    registry.action(session, 'start')
    waiting = registry.action(session, 'obstacle')
    return waiting, registry.action(session, action)


def test_bypass_changes_only_future_path_and_preserves_actor_positions(registry, clock):
    session, _, _ = create(registry)
    registry.action(session, 'start')
    advance_connected(registry, clock, 10)
    before = session.snapshot()
    waiting = registry.action(session, 'obstacle')
    after = registry.action(session, 'obstacle_bypass')
    assert after['distance_m'] == before['distance_m'] == 12
    assert waiting['navigation'] == before['navigation']
    for distance in (0, 3, 9.8, 11.99, 12):
        old, _, _ = point_at(before['navigation']['points'], distance)
        new, _, _ = point_at(after['navigation']['points'], distance)
        assert old == pytest.approx(new)
    assert after['obstacles'] == waiting['obstacles']
    assert after['obstacles'][0]['point'] == {'x': 17, 'y': 0, 'z': 0}
    assert after['navigation']['total_distance_m'] == pytest.approx(distances(after['navigation']['points'])[-1], abs=5e-5)
    extra = after['navigation']['total_distance_m'] - 150
    assert after['navigation']['step_end_distances'] == [100 + extra, 150 + extra]
    assert after['detour_until_m'] == pytest.approx(12 + 12 + extra + 2.2, abs=1e-5)


@pytest.mark.parametrize('action', ['obstacle_bypass', 'obstacle_clear', 'resume'])
def test_bypass_aliases_and_repeated_clicks_never_append_detours(registry, action):
    session, _, _ = create(registry)
    waiting, after = begin_detour(registry, session, action)
    assert after['status'] == 'ACTIVE' and after['obstacle_active'] is False
    assert len(after['obstacles']) == 1 and after['obstacles'] == waiting['obstacles']
    for _ in range(3):
        repeated = registry.action(session, action)
        assert repeated['navigation'] == after['navigation']
        assert repeated['obstacles'] == after['obstacles']
    registry.action(session, 'pause')
    assert registry.action(session, 'obstacle_bypass')['status'] == 'PAUSED'
    assert registry.action(session, 'obstacle_clear')['status'] == 'PAUSED'
    assert registry.action(session, 'resume')['navigation'] == after['navigation']


def test_pending_duplicate_and_second_obstacle_after_person_exits(registry, clock):
    session, _, _ = create(registry)
    registry.action(session, 'start')
    first = registry.action(session, 'obstacle')
    assert registry.action(session, 'obstacle')['obstacles'] == first['obstacles']
    begun = registry.action(session, 'obstacle_bypass')
    for _ in range(2):
        with pytest.raises(DemoError) as exc:
            registry.action(session, 'obstacle')
        assert exc.value.code == 'DETOUR_IN_PROGRESS'
    advance_connected(registry, clock, (begun['detour_until_m'] - .1) / 1.2)
    with pytest.raises(DemoError) as exc:
        registry.action(session, 'obstacle')
    assert exc.value.code == 'DETOUR_IN_PROGRESS'
    advance_connected(registry, clock, .2)
    assert session.detour_until_m is None
    second = registry.action(session, 'obstacle')
    assert [item['id'] for item in second['obstacles']] == ['obstacle-1', 'obstacle-2']
    assert second['obstacles'][0] == first['obstacles'][0]
    final = registry.action(session, 'obstacle_bypass')
    assert final['navigation']['total_distance_m'] > begun['navigation']['total_distance_m']
    assert path_clearance(final['navigation']['points'], [obstacle_polygon(o) for o in final['obstacles']]) >= .65


def test_pause_disconnect_reconnect_preserve_detour_and_do_not_resume(registry, clock):
    session, socket, data = create(registry)
    _, begun = begin_detour(registry, session)
    advance_connected(registry, clock, 1)
    paused = registry.action(session, 'pause')
    advance_connected(registry, clock, 1)
    assert session.distance_m == paused['distance_m']
    registry.action(session, 'resume')
    registry.detach(session, socket)
    clock.advance(15)
    registry.tick()
    assert (session.status, session.pause_reason) == ('PAUSED', 'disconnected')
    assert session.distance_m == pytest.approx(13.2)
    assert session.detour_until_m == begun['detour_until_m']
    registry.authenticate(data['session_id'], data['token'])
    recovered = registry.attach(session).get_nowait()
    assert recovered['status'] == 'PAUSED'
    assert recovered['navigation'] == begun['navigation'] and recovered['obstacles'] == begun['obstacles']
    registry.action(session, 'resume')
    advance_connected(registry, clock, 3)
    assert session.detour_until_m is None
    assert session.obstacles == begun['obstacles']


def test_cancel_keeps_fixed_obstacles_reset_clears_and_rearms(registry, clock):
    session, _, _ = create(registry)
    _, begun = begin_detour(registry, session)
    advance_connected(registry, clock, 4)
    cancelled = registry.action(session, 'cancel')
    assert cancelled['distance_m'] == pytest.approx(4.8)
    assert cancelled['navigation'] == begun['navigation'] and cancelled['obstacles'] == begun['obstacles']
    assert cancelled['detour_until_m'] is None and not cancelled['obstacle_active']
    reset = registry.action(session, 'reset')
    assert reset['navigation'] == initial_navigation(registry.world.payload)
    assert reset['obstacles'] == [] and reset['detour_until_m'] is None
    registry.action(session, 'start')
    advance_connected(registry, clock, 30)
    assert session.distance_m == 32 and len(session.obstacles) == 1


def test_two_visitors_and_old_snapshots_do_not_share_mutable_path_or_obstacles(registry):
    a, qa, _ = create(registry)
    b, _, _ = create(registry)
    before = a.snapshot()
    _, begun = begin_detour(registry, a)
    assert b.snapshot()['navigation'] == before['navigation']
    assert b.obstacles == [] and b.detour_until_m is None
    assert before['obstacles'] == [] and len(before['navigation']['points']) == 3
    # Mutating an exported snapshot must never alter current authoritative state.
    begun['obstacles'][0]['point']['x'] = 999
    begun['navigation']['points'][0]['x'] = 999
    assert a.obstacles[0]['point']['x'] == 5 and a.navigation['points'][0]['x'] == 0
    registry.action(a, 'reset')
    assert all(packet['navigation']['points'][0]['x'] == 0 for packet in list(qa._queue))


@pytest.mark.parametrize('distance', [90, 140])
def test_near_turn_or_end_rejects_obstacle_without_modifying_route(registry, distance):
    session, _, _ = create(registry)
    session.status, session.distance_m, session.obstacle_triggered = 'PAUSED', distance, True
    session.current_step = int(distance >= 100)
    before = session.snapshot()
    with pytest.raises(DemoError) as exc:
        registry.action(session, 'obstacle')
    assert exc.value.code == 'NO_DETOUR_SPACE'
    assert session.snapshot() == before


def test_both_blocked_sides_reject_atomically_and_one_side_chooses_clear_route(registry):
    session, _, _ = create(registry)
    registry.action(session, 'start')
    registry.action(session, 'pause')
    positive = [[4, 1.2], [7, 1.2], [7, 3], [4, 3]]
    negative = [[4, -3], [7, -3], [7, -1.2], [4, -1.2]]
    registry.world.payload['detour_blockers'] = [positive, negative]
    before = session.snapshot()
    with pytest.raises(DemoError) as exc:
        registry.action(session, 'obstacle')
    assert exc.value.code == 'NO_DETOUR_SPACE' and session.snapshot() == before
    registry.world.payload['detour_blockers'] = [negative]
    registry.action(session, 'obstacle')
    state = registry.action(session, 'obstacle_bypass')
    assert max(point['z'] for point in state['navigation']['points'][:65]) > 2.3
    assert path_clearance(state['navigation']['points'][:65], [negative]) >= .65


def test_thin_collider_crossing_is_detected_between_samples():
    points = [{'x': 0, 'y': 0, 'z': 0}, {'x': 1, 'y': 0, 'z': 0}]
    assert path_clearance(points, [[[.499, -1], [.501, -1], [.501, 1], [.499, 1]]]) == 0


def test_delivered_city_detours_clear_all_159_proxies_and_fixed_board(clock):
    world = World.load(DEFAULT_WORLD)
    assert len(world.payload['detour_blockers']) == 159
    registry = Registry(world, Config(run_ticker=False), clock)
    for start in (0, 32):
        plan = plan_detour(world.payload, initial_navigation(world.payload), start, [], 'obstacle-1')
        cumulative = distances(plan.navigation['points'])
        curve = [p for p, distance in zip(plan.navigation['points'], cumulative)
                 if start - 1e-6 <= distance <= plan.until_m - 2.2 + 1e-4]
        assert len(curve) == 65
        assert path_clearance(curve, world.payload['detour_blockers']) >= ACTOR_CLEARANCE_M
        assert path_clearance(curve, [obstacle_polygon(plan.obstacle)]) >= ACTOR_CLEARANCE_M
        # Both actors use the same arc; the person is 2.2m behind the dog.
        for i in range(301):
            dog_distance = start + (plan.until_m - start) * i / 300
            for actor_distance in (dog_distance, max(0, dog_distance - 2.2)):
                p, _, _ = point_at(plan.navigation['points'], actor_distance)
                assert path_clearance([p, p], [obstacle_polygon(plan.obstacle)]) >= ACTOR_CLEARANCE_M
        assert plan.navigation['total_distance_m'] == pytest.approx(151.1078, abs=.0001)


def test_completion_step_distances_and_updated_instruction(registry, clock):
    session, _, _ = create(registry)
    _, begun = begin_detour(registry, session)
    advance_connected(registry, clock, 15)
    assert session.detour_until_m is None and '101' in session.message and '含绕行' in session.message
    advance_connected(registry, clock, 1000)
    assert session.status == 'DONE' and session.current_step == 2
    assert session.distance_m == begun['navigation']['total_distance_m']
    assert session.obstacles == begun['obstacles']


def test_http_text_bypass_and_refresh_include_authoritative_path(client):
    data, headers = api_create(client)
    url = '/api/demo/sessions/' + data['session_id']
    client.post(url + '/actions', headers=headers, json={'action': 'start'})
    waiting = client.post(url + '/actions', headers=headers, json={'action': 'obstacle'}).json()['data']
    reply = client.post(url + '/text', headers=headers, json={'text': '带我绕过障碍'}).json()['data']
    assert reply['state']['status'] == 'ACTIVE' and '绕行' in reply['reply']
    assert reply['state']['obstacles'] == waiting['obstacles']
    snapshot = client.get(url, headers=headers).json()['data']
    assert snapshot['navigation'] == reply['state']['navigation']
    assert snapshot['detour_until_m'] == reply['state']['detour_until_m']


@pytest.mark.parametrize('text', ['暂停绕行', '绕行时停一下'])
def test_pause_words_take_precedence_over_bypass(client, text):
    data, headers = api_create(client)
    url = '/api/demo/sessions/' + data['session_id']
    for action in ('start', 'obstacle', 'obstacle_bypass'):
        client.post(url + '/actions', headers=headers, json={'action': action})
    reply = client.post(url + '/text', headers=headers, json={'text': text}).json()['data']
    assert reply['state']['status'] == 'PAUSED' and reply['state']['pause_reason'] == 'user'
    assert reply['state']['detour_until_m'] is not None
