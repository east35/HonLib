FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Optional: enable the IRC acquisition plugin by adding it as a git submodule
# at acquisition/irc/ before building, then uncomment the next line so its
# extra deps (pydle, etc.) are installed.
# RUN pip install --no-cache-dir -r requirements-irc.txt

COPY app.py library.py progress.py ./
COPY acquisition ./acquisition
COPY static ./static

RUN mkdir -p /data/books /data/config /data/staging

EXPOSE 8765

CMD ["python", "app.py"]
