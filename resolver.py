import socket
import json
import os

CACHE_FILE = "cache.json"

def load_cache():
    if not os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "w") as f:
            json.dump({}, f)
    with open(CACHE_FILE, "r") as f:
        return json.load(f)


def save_cache(cache):
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=4)


def resolve_domain(domain):
    cache = load_cache()

    if domain in cache:
        return cache[domain], True  # True = cached result

    try:
        ip = socket.gethostbyname(domain)
        cache[domain] = ip
        save_cache(cache)
        return ip, False
    except Exception:
        return "Invalid Domain", False
