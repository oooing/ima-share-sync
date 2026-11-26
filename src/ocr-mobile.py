"""One local PP-OCRv5 mobile job. No downloads, keys or network fallback."""
import contextlib
import json
import os
from pathlib import Path
import re
import socket
import sys

protocol = sys.stdout
GIB = 2 ** 30


class LowMemory(RuntimeError):
    pass


def emit(message):
    protocol.write(json.dumps(message, ensure_ascii=False) + "\n")
    protocol.flush()


def no_network(*_args, **_kwargs):
    raise RuntimeError("本地轻量 OCR 禁止联网")


def run(data):
    os.environ.update(OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
    socket.socket.connect = socket.socket.connect_ex = no_network
    import psutil

    if psutil.virtual_memory().available < 1.5 * GIB:
        raise LowMemory("可用内存不足 1.5 GiB，待转换")
    psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)

    import cv2
    import numpy as np
    import pypdfium2 as pdfium
    from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR

    cv2.setNumThreads(1)
    models = Path(data["runtime"]) / "models"
    detect = models / "ch_PP-OCRv5_det_mobile.onnx"
    recognize = models / "ch_PP-OCRv5_rec_mobile.onnx"
    if not detect.is_file() or not recognize.is_file():
        raise RuntimeError("本地轻量模型未安装完整")
    engine = RapidOCR(params={
        "Global.use_cls": False,
        "Det.engine_type": EngineType.ONNXRUNTIME,
        "Rec.engine_type": EngineType.ONNXRUNTIME,
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Det.model_type": ModelType.MOBILE,
        "Rec.model_type": ModelType.MOBILE,
        "Det.model_path": str(detect),
        "Rec.model_path": str(recognize),
        "Rec.rec_batch_num": 1,
        "Det.limit_type": "max",
        "Det.limit_side_len": 1600,
        "Det.mean": [.485, .456, .406],
        "Det.std": [.229, .224, .225],
        "Det.unclip_ratio": 1.5,
        "EngineConfig.onnxruntime.intra_op_num_threads": 1,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    })
    emit({"type": "ready", "device": "CPU"})
    with pdfium.PdfDocument(data["pdfPath"]) as pdf:
        for number in data["pages"]:
            if psutil.virtual_memory().available < GIB:
                raise LowMemory("可用内存不足，已停止识别，原 PDF 已保留")
            if not isinstance(number, int) or not 1 <= number <= len(pdf):
                raise RuntimeError("PDF 页码无效")
            page = pdf[number - 1]
            try:
                # Bound raster memory for unusually large source pages.
                width, height = page.get_size()
                scale = min(2, 2400 / max(width, height))
                bitmap = page.render(scale=scale)
                try:
                    bgr = np.asarray(bitmap.to_pil().convert("RGB"))[:, :, ::-1].copy()
                finally:
                    bitmap.close()
            finally:
                page.close()
            result = engine(bgr)
            lines = [" ".join(line.split()) for line in (result.txts or ()) if line.strip()]
            if not lines:
                raise RuntimeError("本地轻量 OCR 未识别到正文")
            # Deliberately output text lines, not table cells or Markdown directives.
            escaped = [re.sub(r"([\\\x60*_\[\]<>#|])", r"\\\1", line) for line in lines]
            emit({"type": "page", "page": number, "markdown": "  \n".join(escaped)})
    emit({"type": "done"})


if __name__ == "__main__":
    try:
        data = json.loads(sys.stdin.readline())
        with contextlib.redirect_stdout(sys.stderr):
            run(data)
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) and str(error).startswith(("本地", "可用", "PDF")) else "本地轻量 OCR 执行失败，请检查运行环境"
        emit({"type": "error", "message": detail,
              "code": "insufficient-memory" if isinstance(error, LowMemory) else None})
        sys.exit(1)
