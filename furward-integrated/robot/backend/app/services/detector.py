import logging
from dataclasses import dataclass
from typing import Protocol

import cv2
import numpy as np

from app.services.indoor import data_path

COCO_CLASSES = ('person,bicycle,car,motorcycle,airplane,bus,train,truck,boat,traffic light,fire hydrant,stop sign,parking meter,bench,bird,cat,dog,horse,sheep,cow,elephant,bear,zebra,giraffe,backpack,umbrella,handbag,tie,suitcase,frisbee,skis,snowboard,sports ball,kite,baseball bat,baseball glove,skateboard,surfboard,tennis racket,bottle,wine glass,cup,fork,knife,spoon,bowl,banana,apple,sandwich,orange,broccoli,carrot,hot dog,pizza,donut,cake,chair,couch,potted plant,bed,dining table,toilet,tv,laptop,mouse,remote,keyboard,cell phone,microwave,oven,toaster,sink,refrigerator,book,clock,vase,scissors,teddy bear,hair drier,toothbrush').split(',')


@dataclass(frozen=True)
class Detection:
    label: str
    conf: float
    box: tuple[float, float, float, float]


class Detector(Protocol):
    available: bool

    def detect(self, frame_bgr) -> list[Detection]: ...


class NullDetector:
    available = False

    def detect(self, frame_bgr):
        return []


def postprocess(output, original_shape, scale, padding, conf=0.4, classes=None):
    rows = np.asarray(output)
    if rows.ndim != 3 or rows.shape[0] != 1:
        raise ValueError('检测模型输出维度不合法')
    rows = rows[0]
    if rows.shape[0] == 84:
        rows = rows.T
    elif rows.shape[1] != 84:
        raise ValueError('检测模型必须输出 80 个 COCO 类别')
    height, width = original_shape[:2]
    allowed = set(classes) if classes is not None else set(COCO_CLASSES)
    candidates, boxes, scores = [], [], []
    for row in rows:
        if not np.isfinite(row).all():
            continue
        category = int(np.argmax(row[4:]))
        score, label = float(row[4 + category]), COCO_CLASSES[category]
        if score < conf or label not in allowed:
            continue
        cx, cy, w, h = row[:4]
        x1, y1 = (cx-w/2-padding[0])/scale, (cy-h/2-padding[1])/scale
        x2, y2 = (cx+w/2-padding[0])/scale, (cy+h/2-padding[1])/scale
        box = np.clip([x1/width, y1/height, x2/width, y2/height], 0, 1)
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        candidates.append(Detection(label, score, tuple(float(v) for v in box)))
        boxes.append([float(x1), float(y1), float(w/scale), float(h/scale)])
        scores.append(score)
    if not boxes:
        return []
    indices = cv2.dnn.NMSBoxes(boxes, scores, conf, 0.45)
    return [candidates[int(i)] for i in np.asarray(indices).reshape(-1)]


class OnnxYoloDetector:
    available = True

    def __init__(self, model_path, conf, input_size, classes):
        import onnxruntime as ort
        self.session = ort.InferenceSession(str(model_path), providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        self.conf, self.size = conf, input_size
        self.classes = classes.split(',') if isinstance(classes, str) else classes
        self.classes = [v.strip() for v in self.classes]

    def detect(self, frame_bgr):
        h, w = frame_bgr.shape[:2]
        scale = self.size / max(h, w)
        nw, nh = round(w*scale), round(h*scale)
        left, top = (self.size-nw)//2, (self.size-nh)//2
        frame = np.full((self.size, self.size, 3), 114, dtype=np.uint8)
        frame[top:top+nh, left:left+nw] = cv2.resize(frame_bgr, (nw, nh))
        tensor = np.ascontiguousarray(frame[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255
        output = self.session.run(None, {self.input_name: tensor})[0]
        return postprocess(output, (h, w), scale, (left, top), self.conf, self.classes)


def create_detector(settings):
    path = data_path(settings.detector_model_path)
    if path.is_file():
        try:
            return OnnxYoloDetector(path, settings.detector_conf, settings.detector_input_size, settings.obstacle_classes)
        except Exception:
            logging.getLogger(__name__).exception('检测模型加载失败，障碍物识别不可用')
    else:
        logging.getLogger(__name__).warning('检测模型文件不存在，障碍物识别不可用：%s', path)
    return NullDetector()
