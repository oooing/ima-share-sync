"""Optional stand-alone Windows OCR setup. Run manually, outside Obsidian."""
import argparse, hashlib, json, os, shutil, subprocess, sys, urllib.request, venv, zipfile
from pathlib import Path

def progress(message): print(json.dumps({'message':message},ensure_ascii=False),flush=True)

def install_mobile(root, python, reuse):
    progress('正在安装本地轻量 OCR 依赖')
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
        'rapidocr==3.10.0', 'onnxruntime==1.32.0', 'psutil==7.2.2', 'pypdfium2==5.15.2'],
        stdout=sys.stderr, stderr=sys.stderr, check=True)
    models = root / 'models'
    models.mkdir(exist_ok=True)
    expected = {
        'det': ('ch_PP-OCRv5_det_mobile.onnx', '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae'),
        'rec': ('ch_PP-OCRv5_rec_mobile.onnx', '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5'),
    }
    base = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5'
    for kind, (name, checksum) in expected.items():
        target = models / name
        if target.is_file() and hash_file(target) == checksum:
            continue
        progress('正在下载本地轻量模型')
        temporary = target.with_suffix('.onnx.part')
        try:
            if reuse:
                shutil.copyfile(reuse / 'models' / name, temporary)
            else:
                with urllib.request.urlopen(f'{base}/{kind}/{name}', timeout=60) as response, temporary.open('wb') as output:
                    shutil.copyfileobj(response, output)
            if hash_file(temporary) != checksum:
                raise RuntimeError('轻量模型校验失败，请重新安装')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    (root / 'runtime.json').write_text(json.dumps({'schema': 1, 'model': 'PP-OCRv5 mobile'}), encoding='utf-8')
    progress('本地轻量 OCR 已就绪')


def hash_file(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', help='Override the default IMA-Share-Sync runtime directory.')
    parser.add_argument('--reuse', help='Reuse model files from an existing trusted runtime.')
    parser.add_argument('--mode', required=True, choices=['local', 'local-mobile'])
    args=parser.parse_args()
    if sys.version_info[:2] != (3,12): raise RuntimeError('需要 Python 3.12，请安装后重试')
    if os.name != 'nt': raise RuntimeError('本地 OCR 环境只支持 Windows')
    local_app_data = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local')
    directory = 'ocr-mobile' if args.mode == 'local-mobile' else 'ocr'
    root = (Path(args.dest) if args.dest else local_app_data / 'IMA-Share-Sync' / directory).resolve()
    root.mkdir(parents=True,exist_ok=True)
    python=root/'.venv'/'Scripts'/'python.exe'
    if not python.exists(): venv.EnvBuilder(with_pip=True).create(root/'.venv')
    reuse=Path(args.reuse) if args.reuse else None
    if args.mode == 'local-mobile':
        install_mobile(root, python, reuse)
        return
    progress('正在安装本地 OCR 依赖')
    subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check',
        'paddleocr[doc-parser]==3.7.0','paddlepaddle==3.3.1','psutil==7.2.2','pypdfium2==5.15.2'],
        stdout=sys.stderr,stderr=sys.stderr,check=True)
    if reuse:
        for relative in ['runtime/llama','models/gguf','cache/paddlex/official_models/PP-DocLayoutV3']:
            shutil.copytree(reuse/relative,root/relative,dirs_exist_ok=True)
    else:
        progress('正在下载本地模型（约 2 GB）')
        subprocess.run([str(python),'-c',
            "from huggingface_hub import hf_hub_download,snapshot_download; import sys; from pathlib import Path; r=Path(sys.argv[1]); "
            "[hf_hub_download('PaddlePaddle/PaddleOCR-VL-1.6-GGUF',n,local_dir=r/'models'/'gguf') for n in ['PaddleOCR-VL-1.6-GGUF.gguf','PaddleOCR-VL-1.6-GGUF-mmproj.gguf']]; "
            "snapshot_download('PaddlePaddle/PP-DocLayoutV3',local_dir=r/'cache'/'paddlex'/'official_models'/'PP-DocLayoutV3')",str(root)],
            env={**os.environ,'HF_HOME':str(root/'cache'/'huggingface')},stdout=sys.stderr,stderr=sys.stderr,check=True)
        archive=root/'llama-b12359.zip'
        urllib.request.urlretrieve('https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-vulkan-x64.zip',archive)
        target=root/'runtime'/'llama'
        with zipfile.ZipFile(archive) as files:
            for name in files.namelist():
                if not (target/name).resolve().is_relative_to(target.resolve()): raise RuntimeError('运行包路径无效')
            files.extractall(target)
        archive.unlink()
    expected={'PaddleOCR-VL-1.6-GGUF.gguf':'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8',
              'PaddleOCR-VL-1.6-GGUF-mmproj.gguf':'204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a'}
    for name,checksum in expected.items():
        if hash_file(root/'models'/'gguf'/name)!=checksum: raise RuntimeError('模型校验失败，请重新安装')
    (root/'runtime.json').write_text(json.dumps({'schema':1,'model':'PaddleOCR-VL-1.6','llama':'b12359'}),encoding='utf-8')
    progress('本地 OCR 环境已就绪')

if __name__=='__main__':
    try: main()
    except Exception as error:
        progress(str(error) if isinstance(error,RuntimeError) else '安装失败，请检查网络、磁盘或 Python 3.12')
        sys.exit(1)
