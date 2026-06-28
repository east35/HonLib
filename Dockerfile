FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The optional IRC acquisition plugin is a submodule at acquisition/irc and
# currently uses only the Python standard library.

COPY app.py library.py progress.py ./
COPY acquisition ./acquisition
COPY static ./static

RUN mkdir -p /data/books /data/config /data/staging

EXPOSE 8765

CMD ["python", "app.py"]
