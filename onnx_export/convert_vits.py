import os
import torch
from transformers import VitsModel, AutoTokenizer
from pathlib import Path

OUTPUT_DIR = Path("/workspace/vits_onnx_output")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "ORI-Muchim/VITS_multi_speaker_fine_tuning"

print("[1/4] 모델 다운로드 중...")
try:
    model = VitsModel.from_pretrained(MODEL_ID)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    print("[1/4] 완료")
except Exception as e:
    print(f"[ERROR] 모델 로드 실패: {e}")
    raise

print("[2/4] 모델 구조 확인...")
print(f"  - 모델 타입: {type(model)}")
print(f"  - 화자 수: {getattr(model.config, 'num_speakers', 'N/A')}")
print(f"  - 토크나이저: {type(tokenizer)}")

print("[3/4] Optimum ONNX 변환 시도...")
try:
    from optimum.exporters.onnx import main_export
    main_export(
        model_name_or_path=MODEL_ID,
        output=str(OUTPUT_DIR),
        task="text-to-audio",
        framework="pt",
    )
    print("[3/4] Optimum 변환 완료")
except Exception as e:
    print(f"[WARN] Optimum 변환 실패: {e}")
    print("[3/4] 수동 torch.onnx.export 시도...")
    try:
        model.eval()
        dummy_input_ids = torch.LongTensor([[15, 24, 8, 42, 31]])
        dummy_speaker_id = torch.LongTensor([0])
        with torch.no_grad():
            torch.onnx.export(
                model,
                (dummy_input_ids, None, dummy_speaker_id),
                str(OUTPUT_DIR / "model.onnx"),
                input_names=["input_ids", "attention_mask", "speaker_id"],
                output_names=["waveform"],
                dynamic_axes={
                    "input_ids": {0: "batch", 1: "seq_len"},
                    "speaker_id": {0: "batch"},
                    "waveform": {0: "batch", 1: "samples"},
                },
                opset_version=17,
            )
        print("[3/4] 수동 변환 완료")
    except Exception as e2:
        print(f"[ERROR] 수동 변환도 실패: {e2}")
        raise

print("[4/4] 출력 파일 목록:")
for f in OUTPUT_DIR.iterdir():
    size_mb = f.stat().st_size / (1024*1024)
    print(f"  {f.name}: {size_mb:.1f} MB")

print("\n=== 변환 결과 요약 ===")
onnx_files = list(OUTPUT_DIR.glob("*.onnx"))
if onnx_files:
    print(f"SUCCESS: ONNX 파일 {len(onnx_files)}개 생성됨")
else:
    print("FAILED: ONNX 파일 없음")
