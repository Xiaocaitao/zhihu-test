# ACR ECS 自动部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `main` 合并后自动构建容器镜像、推送阿里云 ACR，并通过 SSH 在 ECS 上使用 Docker Compose 更新服务。

**Architecture:** GitHub Actions 在 `push main` 时执行 Node 检查、构建 Docker 镜像并推送 ACR；部署步骤通过 SSH 将 Compose 文件同步到 ECS，执行 `docker compose pull/up`，最后从 ECS 本机访问 `/healthz` 验证服务。部署通过 GitHub Environment secrets 和 `DEPLOY_ENABLED` 变量控制，避免凭证未配置时误触发失败部署。

**Tech Stack:** Node.js 22.18.0、Node 内置 `http`、Docker、Docker Compose、GitHub Actions、阿里云 ACR、阿里云 ECS。

**Spec:** `docs/PRD.md`（本次只补齐公网 Demo 所需的部署壳，不改变 PRD 业务范围）

## Global Constraints

- Node.js 版本保持 `>=22.18.0`。
- 凭证只放 GitHub Secrets 或 ECS 本机，不写入仓库文件。
- 部署只响应 `main` 的 push 或手动触发，不响应普通 PR。
- 容器只监听 ECS 本机的 `127.0.0.1:3000`，暂不直接暴露应用端口。
- 不删除现有知乎工具、测试和用户已有改动。

---

### Task 1: 增加可运行的服务入口

**Files:**
- Create: `src/server.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces `GET /healthz` with HTTP 200 and JSON `{ "ok": true }`.
- Produces `GET /` with service name and environment-independent status information.
- Produces `npm run start` as the container entrypoint.

- [ ] **Step 1: Add the minimal HTTP server**

```ts
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (request.url === "/healthz") {
    response.statusCode = 200;
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.url === "/") {
    response.statusCode = 200;
    response.end(JSON.stringify({ service: "powu", status: "running" }));
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ ok: false, error: "not_found" }));
});

server.listen(port, host, () => {
  console.log(`powu server listening on ${host}:${port}`);
});
```

- [ ] **Step 2: Add the start script and include the server in type checking**

```json
"scripts": {
  "start": "node src/server.ts",
  "tool": "node --env-file-if-exists=.env scripts/tool.ts",
  "test": "node --test tests/*.test.ts",
  "typecheck": "tsc --noEmit"
}
```

The existing `src/**/*.ts` include already covers `src/server.ts`; no broader source scope is added.

- [ ] **Step 3: Run the focused verification**

Run: `npm run typecheck`

Expected: command exits with code 0.

### Task 2: Add the container and ECS Compose definition

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `deploy/docker-compose.yml`

**Interfaces:**
- Docker image starts with `npm run start` and listens on container port `3000`.
- Compose consumes `ACR_IMAGE` and optional `APP_PORT`; it does not contain credentials.

- [ ] **Step 1: Add the Dockerfile**

```dockerfile
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["npm", "run", "start"]
```

- [ ] **Step 2: Exclude local-only files**

```text
.env
.git
.github
node_modules
tests
docs
```

- [ ] **Step 3: Add the ECS Compose file**

```yaml
services:
  powu:
    image: ${ACR_IMAGE:?ACR_IMAGE is required}
    container_name: powu
    restart: unless-stopped
    environment:
      HOST: 0.0.0.0
      PORT: 3000
    ports:
      - "127.0.0.1:${APP_PORT:-3000}:3000"
```

- [ ] **Step 4: Build and run the container locally**

Run: `docker build -t powu:local . && docker run --rm -d --name powu-local -p 127.0.0.1:3000:3000 powu:local`

Run: `curl --fail http://127.0.0.1:3000/healthz`

Expected: response contains `{ "ok": true }`.

Run: `docker rm -f powu-local`

Expected: the single named local test container is removed.

### Task 3: Add the GitHub Actions deployment workflow and runbook

**Files:**
- Create: `.github/workflows/deploy.yml`
- Create: `docs/deployment.md`

**Interfaces:**
- `DEPLOY_ENABLED=true` enables deployment after a `main` push.
- Required secrets are `ACR_REGISTRY`, `ACR_NAMESPACE`, `ACR_USERNAME`, `ACR_PASSWORD`, `ECS_HOST`, `ECS_USER`, and `ECS_SSH_KEY`.
- The workflow publishes `${ACR_REGISTRY}/${ACR_NAMESPACE}/powu:${GITHUB_SHA}` and `:latest`.

- [ ] **Step 1: Add a gated deployment workflow**

The workflow must:

1. Trigger on `push` to `main` and `workflow_dispatch`.
2. Skip the deploy job unless repository variable `DEPLOY_ENABLED` equals `true`.
3. Run `npm ci`, `npm run typecheck`, and `npm test` before the image build.
4. Log in to ACR with `docker/login-action@v3`.
5. Build and push both immutable SHA and `latest` tags with `docker/build-push-action@v6`.
6. Upload `deploy/docker-compose.yml` to `/opt/powu/docker-compose.yml`.
7. SSH to ECS, run `docker login --password-stdin`, write `/opt/powu/.env`, run `docker compose pull` and `docker compose up -d --remove-orphans`, then poll `/healthz` locally on ECS.

- [ ] **Step 2: Document one-time configuration**

Document the exact GitHub variable/secrets, ECS prerequisites (`docker` and `docker compose`), the local SSH health-check command, and the rollback command using a previous SHA image tag. State explicitly that no secret belongs in `.env`, Compose, or workflow literals.

- [ ] **Step 3: Validate workflow syntax and documentation**

Run: `git diff --check && npm run typecheck && npm test`

Expected: all commands exit with code 0. If a YAML parser is available locally, parse `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`; otherwise rely on GitHub Actions workflow validation after the PR is opened.

### Task 4: Configure external services and verify end to end

**External configuration:**
- Create/select an Alibaba Cloud ACR namespace and repository.
- Install Docker and Docker Compose on ECS.
- Add the repository variable `DEPLOY_ENABLED=true` and the seven repository secrets documented in `docs/deployment.md`.
- Merge the deployment PR into `main`.

- [ ] **Step 1: Verify the `main` push workflow**

Expected: CI succeeds, the deploy job is enabled, and ACR contains both the SHA and `latest` tags.

- [ ] **Step 2: Verify ECS health**

Run through the SSH deploy step: `curl --fail http://127.0.0.1:3000/healthz`.

Expected: HTTP 200 with `{ "ok": true }`.

- [ ] **Step 3: Verify rollback**

Set `ACR_IMAGE` on ECS to a previously published SHA tag and run `docker compose up -d`; confirm `/healthz` remains available.

