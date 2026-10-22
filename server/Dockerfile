# Build from this folder (trade_folder on the VM):  docker build .
FROM node:22-slim AS node

FROM python:3.11-slim

# The signal engine is the app's own JavaScript (copied into js/), run with Node.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# LightGBM needs the OpenMP runtime.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY package.json main.py service.py ml.py events.py crypto.py ndax.py engine.mjs opportunities.mjs stocks.mjs proxy.mjs sp500.csv generate_vapid_keys.py ./
COPY js ./js

ENV DATA_DIR=/data
EXPOSE 8004

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8004/health', timeout=3)" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8004"]
