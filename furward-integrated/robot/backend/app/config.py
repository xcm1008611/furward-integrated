from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore', allow_inf_nan=False)
    obstacle_source: Literal['none', 'mock', 'video', 'rtsp'] = 'mock'
    rtsp_url: str = ''
    video_path: str = ''
    # .env 读入的是字符串，Literal[0, 90, ...] 不会把 '0' 转成 0，所以用 int 加校验。
    frame_rotate: int = 0
    detector_model_path: str = 'models/yolov8n.onnx'
    detector_conf: float = Field(0.4, ge=0, le=1)
    detector_input_size: int = Field(640, gt=0)
    obstacle_classes: str = 'person,chair,bench,suitcase,backpack,handbag,bicycle,potted plant,dining table,couch,dog,bottle,box'
    zone_top_y: float = Field(0.55, ge=0, lt=1)
    zone_top_left: float = Field(0.35, ge=0, le=1)
    zone_top_right: float = Field(0.65, ge=0, le=1)
    zone_bottom_left: float = Field(0.15, ge=0, le=1)
    zone_bottom_right: float = Field(0.85, ge=0, le=1)
    stop_height_ratio: float = Field(0.35, gt=0, le=1)
    caution_height_ratio: float = Field(0.20, gt=0, le=1)
    stop_confirm_frames: int = Field(2, ge=1)
    clear_hold_s: float = Field(1.5, ge=0)
    obstacle_fps: float = Field(10, gt=0)
    obstacle_auto_resume: bool = False
    stream_fps: float = Field(5, gt=0)
    camera_health_s: float = Field(2, gt=0)
    camera_reconnect_s: float = Field(2, gt=0)
    camera_timeout_ms: int = Field(1000, gt=0)

    @field_validator('frame_rotate')
    @classmethod
    def validate_frame_rotate(cls, value: int) -> int:
        if value not in (0, 90, 180, 270):
            raise ValueError('FRAME_ROTATE 只能是 0、90、180 或 270')
        return value

    @model_validator(mode='after')
    def validate_vision(self):
        if self.zone_top_left >= self.zone_top_right or self.zone_bottom_left >= self.zone_bottom_right:
            raise ValueError('通行区域左边界必须小于右边界')
        if self.caution_height_ratio >= self.stop_height_ratio:
            raise ValueError('提醒阈值必须小于停止阈值')
        return self

    deepseek_api_key: str = ''
    deepseek_base_url: str = 'https://api.deepseek.com'
    deepseek_model: str = 'deepseek-flash'
    llm_enabled: bool = True
    llm_timeout_s: float = Field(5.0, gt=0)
    vision_timeout_s: float = Field(8.0, gt=0)
    assistant_history_turns: int = Field(5, ge=0)
    amap_js_key: str = ''
    amap_security_code: str = ''
    amap_key: str = ''
    amap_base_url: str = 'https://restapi.amap.com'
    amap_timeout_s: float = Field(5.0, gt=0)
    outdoor_city: str = '上海'
    outdoor_default_origin: str = ''
    nav_arrive_radius_m: float = Field(15.0, gt=0)
    indoor_map_path: str = 'data/indoor_map.json'
    demo_routes_dir: str = 'data/demo_routes'
    demo_city_path: str = 'data/demo_city.json'
    nav_progress_interval_s: float = Field(0.5, gt=0)
    nav_settle_s: float = Field(0.5, ge=0)
    nav_turn_threshold_deg: float = Field(5.0, ge=0)
    nav_resume_min_move_m: float = Field(0.05, ge=0)
    nav_resume_min_turn_deg: float = Field(3.0, ge=0)
    lan_host: str = ''
    host: str = '0.0.0.0'
    port: int = Field(8000, ge=1, le=65535)
    robot_backend: Literal['mock', 'bridge'] = 'mock'
    bridge_token: str = ''
    bridge_ping_interval_s: float = Field(1.0, gt=0)
    bridge_stale_s: float = Field(3.0, gt=0)
    mock_time_scale: float = Field(1.0, gt=0)
    mock_fail: str = ''
    mock_battery_start: int = Field(90, ge=0, le=100)
    linear_speed: float = Field(0.3, ge=0.2, le=0.4)
    angular_speed: float = Field(0.5, gt=0)
    max_move_m: float = Field(3.0, gt=0)
    max_turn_deg: float = Field(180.0, gt=0)
    calib_linear_scale: float = Field(1.0, gt=0)
    calib_angular_scale: float = Field(1.0, gt=0)
    cmd_deadline_s: float = Field(20.0, gt=0)
    state_interval_s: float = Field(1.0, gt=0)
    event_queue_size: int = Field(128, ge=1)


@lru_cache
def get_settings() -> Settings:
    return Settings()
