from flask import Flask, request, jsonify
import socket
import csv
import os
import time
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

LOG_FILE = "dns_log.csv"   # Full history file (timestamp, domain, ip, source)
CACHE_LIMIT = 10           # Number of latest lookups returned for suggestions


# ---------- Ensure CSV exists with header ----------
if not os.path.exists(LOG_FILE):
    with open(LOG_FILE, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["timestamp", "domain", "ip", "source"])


# ---------- One-time CSV normalizer (fix old 2-column logs) ----------
def normalize_csv():
    rows = []

    with open(LOG_FILE, "r") as f:
        reader = csv.reader(f)
        _ = next(reader, None)

        for row in reader:
            # Convert old format (domain, ip) → full format
            if len(row) == 2:
                domain, ip = row
                rows.append([
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    domain, ip, "old_cache"
                ])

            # Keep new format (timestamp, domain, ip, source)
            elif len(row) == 4:
                rows.append(row)

    # Write back normalized CSV
    with open(LOG_FILE, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["timestamp", "domain", "ip", "source"])
        writer.writerows(rows)


# Run normalizer on startup ✅
normalize_csv()


# ---------- Load Full History ----------
def load_history():
    entries = []
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "r") as f:
            for row in csv.DictReader(f):
                if not row.get("timestamp") or not row.get("domain") or not row.get("ip"):
                    continue   # Skip corrupted rows
                entries.append(row)
    return entries


# ---------- Save Lookup ----------
def log_lookup(domain, ip, source):
    with open(LOG_FILE, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            time.strftime("%Y-%m-%d %H:%M:%S"),
            domain, ip, source
        ])


# ---------- Recent Suggestions ----------
def recent_suggestions():
    history = load_history()
    return history[::-1][:CACHE_LIMIT]  # latest N items reversed


# ---------- Resolve Domain API ----------
@app.route("/resolve", methods=["POST"])
def resolve_domain():
    data = request.get_json()
    domain = data.get("domain")

    if not domain:
        return jsonify({"error": "No domain provided"}), 400

    # Check cache (history)
    history = load_history()
    for entry in history[::-1]:
        if entry["domain"] == domain:
            log_lookup(domain, entry["ip"], "cache_hit")
            return jsonify({
                "domain": domain,
                "ip": entry["ip"],
                "cached": True,
                "source": entry["source"]
            })

    # Not cached → resolve
    try:
        ip = socket.gethostbyname(domain)
        log_lookup(domain, ip, "resolved")  # ✅ add timestamp & source
        return jsonify({
            "domain": domain,
            "ip": ip,
            "cached": False,
            "source": "resolved"
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------- Suggestions API ----------
@app.route("/suggest", methods=["GET"])
def suggest():
    return jsonify(recent_suggestions())


# ---------- Full History API ----------
@app.route("/history", methods=["GET"])
def history():
    return jsonify(load_history())


# ---------- Run Flask ----------
if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0")
