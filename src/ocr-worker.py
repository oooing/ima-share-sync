"""Local-only PaddleOCR-VL worker. No cloud fallback and no API credentials."""
import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

protocol = sys.stdout

class InsufficientMemory(RuntimeError):
    pass

def emit(value):
    protocol.write(json.dumps(value, ensure_ascii=False) + '\n')
    protocol.flush()

def run(data):
    runtime = Path(data['runtime'])
    os.environ.update({'PADDLE_PDX_CACHE_HOME': str(runtime/'cache'/'paddlex'),
        'HF_HOME': str(runtime/'cache'/'huggingface'), 'HF_HUB_OFFLINE':'1',
        'PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK':'True',
        'PADDLE_HOME':str(runtime/'cache'/'paddle'), 'OMP_NUM_THREADS':'4', 'MKL_NUM_THREADS':'4'})
    import psutil
    psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    if psutil.virtual_memory().available < 6 * 2**30:
        raise InsufficientMemory('可用内存不足 6 GB，待转换')
    exe = runtime/'runtime'/'llama'/'llama-server.exe'
    model = runtime/'models'/'gguf'/'PaddleOCR-VL-1.6-GGUF.gguf'
    projection = runtime/'models'/'gguf'/'PaddleOCR-VL-1.6-GGUF-mmproj.gguf'
    layout = runtime/'cache'/'paddlex'/'official_models'/'PP-DocLayoutV3'
    if not all(p.exists() for p in [exe,model,projection,layout/'inference.pdiparams']):
        raise RuntimeError('本地 OCR 环境不完整，请先安装或修复')
    devices = subprocess.run([str(exe),'--list-devices'],capture_output=True,timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW)
    import re
    available = re.findall(r'(Vulkan\d+):\s*([^\r\n]+)', (devices.stdout+devices.stderr).decode('utf-8',errors='replace'))
    if not available: raise RuntimeError('未找到可用的 Vulkan 显卡；不会改用 CPU 或 API')
    device = next((key for key,name in available if 'Intel' in name),available[0][0])
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    cmd=[str(exe),'-m',str(model),'--mmproj',str(projection),'--host','127.0.0.1',
        '--port',str(port),'--temp','0','--ctx-size','16384','--parallel','1',
        '--threads','4','--threads-batch','4','--device',device,'--n-gpu-layers','99']
    server = subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    try:
        deadline=time.monotonic()+120
        while time.monotonic()<deadline:
            if server.poll() is not None: raise RuntimeError('本地 OCR 加速服务启动失败，请检查显卡驱动')
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=2) as response:
                    if response.status==200: break
            except Exception: pass
            time.sleep(.3)
        else: raise RuntimeError('本地 OCR 服务启动超时')
        from paddleocr import PaddleOCRVL
        import pypdfium2 as pdfium
        import numpy as np
        pipeline=PaddleOCRVL(pipeline_version='v1.6',device='cpu',cpu_threads=4,
            layout_detection_model_dir=str(layout),vl_rec_backend='llama-cpp-server',
            vl_rec_server_url=f'http://127.0.0.1:{port}/v1',vl_rec_max_concurrency=1,
            use_queues=False,use_chart_recognition=False,use_doc_orientation_classify=False,use_doc_unwarping=False)
        emit({'type':'ready','device':device})
        with pdfium.PdfDocument(data['pdfPath']) as pdf:
            for number in data['pages']:
                if psutil.virtual_memory().available<2*2**30: raise InsufficientMemory('可用内存不足，已暂停 OCR，原 PDF 已保留')
                if not isinstance(number,int) or not 1<=number<=len(pdf): raise RuntimeError('PDF 页码无效')
                page=pdf[number-1]
                try:
                    bitmap=page.render(scale=2)
                    try: image=np.array(bitmap.to_pil().convert('RGB'))
                    finally: bitmap.close()
                finally: page.close()
                results=list(pipeline.predict_iter(image))
                if len(results)!=1: raise RuntimeError('本地 OCR 页面结果不完整')
                markdown=results[0].markdown.get('markdown_texts','')
                if not markdown.strip(): raise RuntimeError('本地 OCR 未识别到正文')
                emit({'type':'page','page':number,'markdown':markdown})
        emit({'type':'done'})
    finally:
        if server.poll() is None:
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired: server.kill(); server.wait()

if __name__=='__main__':
    try:
        data=json.loads(sys.stdin.readline())
        with contextlib.redirect_stdout(sys.stderr): run(data)
    except Exception as error:
        # Never return arbitrary backend URLs, local logs, or stack traces to notes.
        message=str(error) if isinstance(error,RuntimeError) and str(error).startswith(('可用','本地','未找到','PDF')) else '本地 OCR 执行失败，请检查运行环境'
        emit({'type':'error','message':message,
              'code':'insufficient-memory' if isinstance(error,InsufficientMemory) else None})
        sys.exit(1)
