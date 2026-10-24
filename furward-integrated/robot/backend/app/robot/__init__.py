from app.config import Settings
from app.robot.gateway import RobotGateway
from app.robot.mock import MockRobot
from app.robot.bridge_client import BridgeRobot


def create_gateway(settings: Settings) -> RobotGateway:
    if settings.robot_backend == 'bridge':
        return BridgeRobot(settings)
    return MockRobot(settings)
