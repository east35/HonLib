FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The optional IRC acquisition plugin is a submodule at acquisition/irc and
# currently uses only the Python standard library.

COPY app.py library.py progress.py web_bundle.py wsgi.py ./
COPY acquisition ./acquisition
COPY static ./static
COPY scripts/build_web_bundle.py ./scripts/build_web_bundle.py

RUN python scripts/build_web_bundle.py /app/app-bundle

RUN test -f /app/static/vendor/foliate-js/view.js || \
    (echo "Foliate submodule missing; run: git submodule update --init static/vendor/foliate-js" >&2; exit 1)

RUN mkdir -p /data/books /data/config /data/staging

EXPOSE 8765

CMD ["gunicorn", "--bind=0.0.0.0:8765", "--workers=1", "--threads=8", "--timeout=120", "--access-logfile=-", "wsgi:app"]
