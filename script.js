// Live suggestions (DuckDuckGo Instant Answer) + resolve flow
const API_BASE = "http://127.0.0.1:5000"; // your Flask backend (used for /resolve)
const ddgEndpoint = "https://api.duckduckgo.com/?q="; // we'll append &format=json

const input = document.getElementById("domainInput");
const dropdown = document.getElementById("suggestionsDropdown");
const output = document.getElementById("output");
const resolveBtn = document.getElementById("resolveBtn");

// history (localStorage) key
const HISTORY_KEY = "dnsHistory";
const HISTORY_MAX = 100;

// debounce helper
function debounce(fn, delay=300){
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(()=> fn(...args), delay);
  };
}

// parse DuckDuckGo response to suggestions (title + domain)
async function fetchDDGSuggestions(q) {
  if (!q || q.trim().length < 1) return [];
  try {
    const url = ddgEndpoint + encodeURIComponent(q) + "&format=json&pretty=1";
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];

    // DuckDuckGo returns Results and RelatedTopics
    if (Array.isArray(json.Results)) {
      json.Results.forEach(r => {
        if (r.Text && r.FirstURL) {
          try {
            const domain = (new URL(r.FirstURL)).hostname.replace(/^www\./,'');
            items.push({ title: r.Text, domain });
          } catch(e){}
        }
      });
    }

    if (Array.isArray(json.RelatedTopics)) {
      json.RelatedTopics.forEach(rt => {
        if (rt.Text && rt.FirstURL) {
          try {
            const domain = (new URL(rt.FirstURL)).hostname.replace(/^www\./,'');
            items.push({ title: rt.Text, domain });
          } catch(e){}
        } else if (rt.Topics && Array.isArray(rt.Topics)) {
          rt.Topics.forEach(t => {
            if (t.Text && t.FirstURL) {
              try {
                const domain = (new URL(t.FirstURL)).hostname.replace(/^www\./,'');
                items.push({ title: t.Text, domain });
              } catch(e){}
            }
          });
        }
      });
    }

    // dedupe by domain (keep first occurrence)
    const seen = new Set();
    const dedup = [];
    for (const it of items) {
      if (!it.domain) continue;
      if (seen.has(it.domain)) continue;
      seen.add(it.domain);
      dedup.push(it);
    }
    return dedup;
  } catch (err) {
    console.warn("DDG suggestion error", err);
    return [];
  }
}

// show dropdown
function showDropdown(items) {
  dropdown.innerHTML = "";
  if (!items || items.length === 0) {
    dropdown.hidden = true;
    return;
  }
  items.slice(0,10).forEach(it => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="suggestion-title">${escapeHtml(it.title || it.domain)}</span>
                    <span class="suggestion-domain">${escapeHtml(it.domain)}</span>`;
    li.addEventListener("click", () => {
      input.value = it.domain;
      dropdown.hidden = true;
      resolveDomain();
    });
    dropdown.appendChild(li);
  });
  dropdown.hidden = false;
}

// escape simple html
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// debounce version called on input
const onType = debounce(async (text) => {
  if (!text || text.trim().length < 1) { dropdown.hidden = true; return; }
  const suggestions = await fetchDDGSuggestions(text);
  showDropdown(suggestions);
}, 300);

// keyboard handlers
input.addEventListener("input", (e) => {
  onType(e.target.value);
});
input.addEventListener("focus", (e) => {
  if (input.value.trim().length) onType(input.value);
});
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".input-wrap") && !ev.target.closest("#suggestionsDropdown")) {
    dropdown.hidden = true;
  }
});

// resolve behavior: try backend first, fallback to DNS-over-HTTPS (Google)
async function resolveDomain() {
  const domain = input.value.trim();
  if (!domain) {
    output.textContent = "Please enter a domain name";
    return;
  }

  output.textContent = "Resolving...";
  try {
    // Try backend /resolve
    const backendRes = await fetch(`${API_BASE}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain })
    }).catch(()=> null);

    if (backendRes && backendRes.ok) {
      const data = await backendRes.json();
      if (data.error) {
        throw new Error(data.error);
      }
      const ip = data.ip || "—";
      output.textContent = `${domain} → ${ip} ${data.cached ? "(cached)" : ""}`;
      saveToHistory(domain, ip, data.source || (data.cached ? "cached" : "resolved"));
      scheduleClear();
      return;
    }

    // fallback to DNS-over-HTTPS (Google)
    const doh = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`);
    const dohJson = await doh.json();
    if (dohJson && dohJson.Answer && dohJson.Answer.length) {
      const ip = dohJson.Answer[0].data;
      output.textContent = `${domain} → ${ip}`;
      saveToHistory(domain, ip, "doh");
      scheduleClear();
    } else {
      output.textContent = `Could not resolve ${domain}`;
    }

  } catch (err) {
    console.error("resolve error:", err);
    output.textContent = `Error: ${err.message || err}`;
  }
}

// schedule auto-clear after 60 seconds (clear only the output text)
let clearTimer = null;
function scheduleClear() {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    output.textContent = "No query yet — enter a domain and press Resolve.";
    clearTimer = null;
  }, 60000);
}

// localStorage history helpers (trim to HISTORY_MAX)
function saveToHistory(domain, ip, source="Browser") {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push({
      timestamp: new Date().toLocaleString(),
      domain,
      ip,
      source
    });
    const trimmed = arr.slice(-HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.error("saveToHistory failed", e);
  }
}

// auto-load suggestions from history (quick access) - merges with live suggestions
async function loadHistorySuggestions() {
  const raw = localStorage.getItem(HISTORY_KEY);
  const history = raw ? JSON.parse(raw) : [];
  // pick unique last 6 domains (newest first)
  const uniq = [];
  const seen = new Set();
  for (let i = history.length - 1; i >= 0 && uniq.length < 6; i--) {
    const d = history[i].domain;
    if (!seen.has(d)) {
      uniq.push({ title: "Recent", domain: d });
      seen.add(d);
    }
  }
  return uniq;
}

// wire buttons
resolveBtn.addEventListener("click", () => { resolveDomain(); dropdown.hidden = true; });
input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); resolveDomain(); dropdown.hidden = true; }});

// on load: show recent history suggestions under dropdown when input focused
input.addEventListener("focus", async () => {
  const historyItems = await loadHistorySuggestions();
  if (historyItems.length) showDropdown(historyItems);
});

// helper to merge history items + ddg items (not necessary as we show either live or history)
async function init() {
  // nothing else required right now
}
init();
