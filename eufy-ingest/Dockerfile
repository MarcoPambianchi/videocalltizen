# C2 — shim P2P Eufy -> go2rtc
FROM python:3.12-slim

# ffmpeg : passthrough video H.264 + publication RTSP vers go2rtc.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY shim.py ./

CMD ["python3", "shim.py"]
