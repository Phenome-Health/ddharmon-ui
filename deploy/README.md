# ddharmon-ui Deployment (AWS Lightsail — systemd + nginx)

Step-by-step guide for deploying **ddharmon-ui** to a single always-on VM (AWS Lightsail or any
Ubuntu host), mirroring the biomapper-ui deploy pattern but with **one** process.

Replace `$DEPLOY_DIR` (e.g. `/home/ubuntu/ddharmon-ui`) and `$DOMAIN`
(e.g. `harmonize.phenomehealth.org`) throughout.

## Architecture (read first)

```
browser ──HTTPS──> nginx (:443, TLS) ──proxy──> uvicorn (127.0.0.1:8000)
                                                   └─ FastAPI: serves the built SPA + /api
                                                      └─ ddharmon pipeline (in-process):
                                                         embed (sentence-transformers/torch)
                                                         → BERTopic (UMAP/HDBSCAN)
                                                         → value sub-cluster → CDE anchor
                                                         → classify (none | sync | batch)
```

**Why a single always-on instance (NOT autoscale / scale-to-zero):**
- The job store is **in-memory** — jobs are lost on restart and invisible across processes.
- Progress is streamed over **SSE** (long-lived connections).
- The ML pipeline runs **in-process** in a background thread.

→ Run exactly **one uvicorn process, one worker**. Do not add `--workers >1`.

## Prerequisites

- Ubuntu host with **≥ 4 GB RAM** (8 GB comfortable — torch + UMAP/HDBSCAN are memory-hungry),
  ~6 GB free disk (torch + the ~420 MB embedding model + node_modules). On Lightsail, the
  **$20+/mo** plan (4 GB RAM) is the practical minimum.
- **Python 3.12+** (the project requires `>=3.12`).
- **Node 20+** and npm (for the one-time frontend build).
- **nginx**, **certbot** (`python3-certbot-nginx`).
- **uv** (recommended) or pip.
- **Git read access to two private Phenome-Health repos:**
  - `Phenome-Health/ddharmon-ui` — to clone this app.
  - `Phenome-Health/ddharmon` — installed transitively as the `ddharmon[all]` dependency.

  See **[Git auth for the private repos](#git-auth-for-the-private-repos)** below before step 2.

```bash
# uv (if not present)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Git auth for the private repos

The simplest method that covers **both** the clone *and* the `ddharmon` git dependency is a
**GitHub token** (a fine-grained PAT with read access to the Phenome-Health repos, or a classic
token with `repo` scope). Wire it into git once so every `https://github.com/...` fetch — including
the one pip/uv runs for the dependency — authenticates:

```bash
export GH_TOKEN=ghp_xxx   # token with read access to Phenome-Health/ddharmon{,-ui}
git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
```

(Alternative: an **SSH deploy key** works for the clone, but a single deploy key can't be reused
across both repos, so the `git+https` dependency still needs a token or a machine-user key. The
token approach above is the least fuss.)

## 1. Squarespace DNS — point a subdomain at the instance (do early)

DNS propagation can take minutes to hours, so set this up first.

1. In the AWS Lightsail console, create/attach a **static IP** to the instance (so it survives
   reboots). Note the IP.
2. In **Squarespace → your domain → DNS / DNS Settings**, add a **custom A record**:
   - **Host/Name:** the subdomain label, e.g. `harmonize` (for `harmonize.phenomehealth.org`).
   - **Type:** `A`
   - **Value/Data:** the Lightsail **static IP**.
   - (Leave TTL at the default.)
3. Confirm it resolves (later — propagation lag is normal):

```bash
dig +short $DOMAIN     # should eventually return the Lightsail static IP
```

> **More internal tools later = more subdomains.** Each tool gets its own subdomain A record
> (e.g. `harmonize.`, `link.`, …). Simplest is one Lightsail instance per tool, each subdomain
> pointing at its own IP. To host several apps on one instance instead, give each its own nginx
> `server` block (distinct `server_name` + upstream port) and run `certbot` per subdomain.

## 2. Clone the repository

```bash
ssh ubuntu@<INSTANCE_IP>
cd ~
git clone https://github.com/Phenome-Health/ddharmon-ui.git
cd ddharmon-ui                               # this is $DEPLOY_DIR
```

## 3. Python dependencies (pulls the full ML stack via `ddharmon[all]`)

Installing this app resolves `ddharmon[all]` from the **private** `Phenome-Health/ddharmon` git
repo (needs the token from [Git auth](#git-auth-for-the-private-repos)) and pulls torch +
sentence-transformers + BERTopic/UMAP/HDBSCAN — several minutes.

```bash
uv venv
uv pip install -e .
# or, without uv:  python3 -m venv .venv && .venv/bin/pip install -e .
```

## 4. Build the frontend (one-time; output is gitignored)

The FastAPI app mounts `frontend/dist` at `/` when present. `dist/` is not in git, so build it:

```bash
cd frontend
npm ci
npm run build          # produces frontend/dist
cd ..
```

## 5. CDE catalog (server-side; NOT in git)

`data/cde/` is gitignored, so a fresh clone has **no** catalog. Pick one:

- **No CDE anchoring** — run with `cdeSet = none` in the UI. Nothing to install here; skip to step 6.
- **With CDE anchoring** — get the flat TSVs onto the server (they load automatically):
  - The app expects `data/cde/nih_endorsed_flat.tsv` (cdeSet `endorsed`) and/or
    `data/cde/all_cdes_flat.tsv` (cdeSet `full`). Override the dir with `DDHARMON_CDE_DIR`.
  - Copy prebuilt flat TSVs from a machine that has them:
    ```bash
    # from your laptop:
    ssh ubuntu@<INSTANCE_IP> 'mkdir -p $DEPLOY_DIR/data/cde'
    scp nih_endorsed_flat.tsv all_cdes_flat.tsv ubuntu@<INSTANCE_IP>:$DEPLOY_DIR/data/cde/
    ```
  - To (re)generate the flat TSVs from the source CDE JSON, use `scripts/flatten_cde_repo.py`
    from a **ddharmon core** checkout (that script lives in the core repo, not here):
    ```bash
    # in a ddharmon checkout:
    python scripts/flatten_cde_repo.py NIH-endorsed-CDEs.json nih_endorsed_flat.tsv
    python scripts/flatten_cde_repo.py All-CDEs.json          all_cdes_flat.tsv
    ```

## 6. Environment file

```bash
cp deploy/.env.example .env
nano .env       # set ANTHROPIC_API_KEY only if you'll use classifyMode sync|batch
```

## 7. Warm the embedding model (recommended)

Pre-download `all-mpnet-base-v2` (~420 MB) into the deploy-dir cache now, so the first run isn't
slow and any download/permission issue surfaces at deploy time rather than mid-job:

```bash
HF_HOME=$DEPLOY_DIR/.cache/huggingface \
SENTENCE_TRANSFORMERS_HOME=$DEPLOY_DIR/.cache/sentence-transformers \
.venv/bin/python -c "from ddharmon.embedding.provider import SentenceTransformerProvider; SentenceTransformerProvider()"
```

## 8. systemd service

```bash
sudo cp deploy/ddharmon.service /etc/systemd/system/
sudo sed -i "s|\$DEPLOY_DIR|$DEPLOY_DIR|g" /etc/systemd/system/ddharmon.service
# If the service user isn't `ubuntu`, also edit User=/Group= in the unit.

sudo systemctl daemon-reload
sudo systemctl enable ddharmon
sudo systemctl start ddharmon
```

### Service Management

```bash
sudo systemctl status ddharmon
sudo journalctl -u ddharmon -f       # logs (model load, job progress, errors)
sudo systemctl restart ddharmon
```

## 9. nginx configuration

```bash
sudo cp deploy/nginx-ddharmon.conf /etc/nginx/sites-available/ddharmon.conf
sudo sed -i "s|\$DOMAIN|$DOMAIN|g" /etc/nginx/sites-available/ddharmon.conf
sudo ln -s /etc/nginx/sites-available/ddharmon.conf /etc/nginx/sites-enabled/

sudo nginx -t
sudo systemctl reload nginx
```

## 10. DNS propagation check + SSL

```bash
dig +short $DOMAIN                   # confirm it resolves to this host first (step 1)
sudo certbot --nginx -d $DOMAIN      # adds :443 listener + HTTP->HTTPS redirect
```

## 11. (Optional but recommended) Access gate

The app has no built-in auth. If `$DOMAIN` is reachable beyond a trusted network, enable
basic-auth **after** TLS is active (so credentials aren't sent in the clear):

```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.ddharmon_htpasswd <user>
# uncomment the two auth_basic lines in /etc/nginx/sites-available/ddharmon.conf, then:
sudo nginx -t && sudo systemctl reload nginx
```

## 12. Verification

```bash
# App is up (internal):
curl -s http://127.0.0.1:8000/api/health
#   -> {"status":"ok","version":"1.0.0","cde":{"endorsed":true|false,"full":...},"frontendBuilt":true}

# Through nginx + TLS:
curl -s https://$DOMAIN/api/health
curl -s -o /dev/null -w "%{http_code}\n" https://$DOMAIN/      # SPA index -> 200

sudo systemctl is-active ddharmon
```

`frontendBuilt` should be `true` (step 4); each `cde.*` flag reflects which catalog file you
installed in step 5 (both `false` is fine if you only use `cdeSet = none`).

## 13. Redeploy / update

```bash
cd $DEPLOY_DIR
git pull
uv pip install -e . --upgrade       # if deps changed (also pulls a newer ddharmon)
(cd frontend && npm ci && npm run build)   # if frontend changed
sudo systemctl restart ddharmon     # NOTE: in-memory jobs are lost on restart
```

## Notes & Gotchas

- **In-memory jobs** are lost on every restart — fine for the single-user v1 tool; warn users
  before restarting mid-run.
- **One worker only.** Multiple uvicorn workers would split the in-memory job store and break SSE.
- **Memory:** a large `cdeSet = full` run plus a big cohort upload can spike RAM (embeddings +
  UMAP). If the service is OOM-killed (check `journalctl`/`dmesg`), size up the instance or
  prefer `cdeSet = endorsed`.
- **systemd EnvironmentFile precedence:** under systemd, `.env` values come from `EnvironmentFile`;
  when running manually for debugging, `load_dotenv()` reads `.env` instead.
- **First job is slow** if you skipped step 7 (model downloads on first embed).
- **SSE through nginx** relies on `proxy_buffering off` + a long `proxy_read_timeout` — both are
  set in `nginx-ddharmon.conf`; don't re-enable buffering.
