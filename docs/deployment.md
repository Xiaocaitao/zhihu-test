# 知乎黑客松 MVP 部署流程

这份文档记录“破雾” MVP 的协同开发和自动部署流程。比赛时新建仓库后，按本文重新配置一遍即可。

## 部署链路

```text
队员创建 feature 分支
  -> push 到 GitHub 并创建 Pull Request
  -> GitHub Actions 安装依赖、类型检查、运行测试
  -> 负责人合并到 main
  -> GitHub Actions Deploy
  -> 构建 Docker 镜像
  -> 推送 ACR（commit SHA + latest）
  -> SSH 到 ECS
  -> docker-compose pull/up
  -> ECS 本机请求 /healthz
```

## 开发与部署流程图

```mermaid
flowchart LR
  subgraph DEV[队员]
    A[拉取最新 main] --> B[创建 feature 分支]
    B --> C[开发并 push]
    C --> D[创建 Pull Request]
  end

  subgraph GH[GitHub]
    E[CI: npm ci<br/>typecheck<br/>test]
    F{CI 通过?}
    G[负责人合并到 main]
    H[Deploy Action]
  end

  subgraph ACR[阿里云 ACR]
    I[构建 Docker 镜像]
    J[推送 SHA 和 latest 标签]
  end

  subgraph ECS[阿里云 ECS]
    K[SSH 上传 Compose 文件]
    L[docker-compose pull/up]
    M[/healthz 健康检查]
    N[公网服务 :3000]
  end

  D --> E --> F
  F -->|失败，继续修改| C
  F -->|通过| G --> H --> I --> J --> K --> L --> M --> N
```

关键点：

- 提 PR 只触发 CI，不会部署 ECS。
- PR 合并到 main 后，Deploy Action 自动完成 ACR 推送和 ECS 部署。
- 合并后不需要再登录 ECS 手动执行 Docker 命令。
- 队员只需要 GitHub Write 权限，不需要 ECS、ACR 或 SSH 权限。
- ECS 的 SSH 私钥只保存在 GitHub Actions Secrets 中，由 Deploy Action 使用。

工作流文件是 `.github/workflows/deploy.yml`。它只在 `main` push 或手动触发，并且只有仓库变量 `DEPLOY_ENABLED` 为 `true` 时才会真正部署。

对应文件：

| 文件 | 作用 |
|---|---|
| `.github/workflows/ci.yml` | Pull Request 和 `main` 的测试流程 |
| `.github/workflows/deploy.yml` | 构建镜像、推送 ACR、部署 ECS |
| `Dockerfile` | 定义应用镜像 |
| `deploy/docker-compose.yml` | ECS 上的容器启动配置 |
| `docs/PRD.md` | 产品需求文档 |

当前 MVP 提供两个 HTTP 接口：

- `/`：返回服务运行状态
- `/healthz`：健康检查，返回 `{"ok":true}`

## 比赛新建仓库

### 1. 创建空仓库

在 GitHub 创建新仓库，例如 `zhihu-hackathon-2026`。建议创建为空仓库，不要自动生成 README、License 或 `.gitignore`，避免第一次 push 产生冲突。

### 2. 推送项目代码

如果当前项目已经有 Git 历史：

~~~bash
git switch main
git pull origin main
git remote set-url origin git@github.com:<GitHub用户名>/<新仓库名>.git
git push -u origin main
~~~

如果是一个尚未初始化的目录：

~~~bash
git init
git add .
git commit -m "chore: initialize hackathon project"
git branch -M main
git remote add origin git@github.com:<GitHub用户名>/<新仓库名>.git
git push -u origin main
~~~

### 3. 邀请队员

进入 `Settings -> Collaborators -> Add people`，为每位队员授予 `Write` 权限。队员接受邀请后，可以创建分支、push 代码并创建 Pull Request，但不能直接修改受保护的 `main`。

## main 分支保护

进入 `Settings -> Branches`，新增 `main` 的保护规则。

推荐配置：

| 配置项 | 值 |
|---|---|
| Require a pull request before merging | 开启 |
| Required approvals | 比赛快速协作可设为 `0`；需要互审时设为 `1` |
| Require status checks to pass | 开启 |
| Required check | `test` |
| Require conversation resolution | 开启 |
| Allow force pushes | 关闭 |
| Allow deletions | 关闭 |

这样队员不能直接 push `main`，所有改动都经过 PR 和自动测试。负责人可以在 CI 通过后直接合并，不必等待额外 review。

## ACR 配置

在阿里云容器镜像服务中创建镜像仓库：

- 命名空间：建议使用 powu
- 仓库名称：使用 powu，因为当前 Action 的镜像路径固定为 <ACR_NAMESPACE>/powu
- 可见性：比赛 MVP 建议保持私有

在 ACR 访问凭证页面设置固定密码。配置 GitHub Secret 时，ACR_REGISTRY 只填写登录地址，不要带 https://。如果仓库名称不叫 powu，需要同步修改 .github/workflows/deploy.yml 中的镜像路径。

常见配置形式：

~~~text
ACR_REGISTRY=crpi-xxxx.cn-beijing.personal.cr.aliyuncs.com
ACR_NAMESPACE=powu
ACR_USERNAME=<阿里云显示的用户名>
ACR_PASSWORD=<ACR固定密码>
~~~

密码不能写入代码、Compose 文件或 ECS 命令历史。

## GitHub 一次性配置

进入仓库 `Settings -> Secrets and variables -> Actions`：

### Variables

| 名称 | 值 |
|---|---|
| `DEPLOY_ENABLED` | `true` |

### Secrets

| 名称 | 内容 |
|---|---|
| `ACR_REGISTRY` | ACR 登录地址，例如 `crpi-xxxx.cn-beijing.personal.cr.aliyuncs.com`，不要带 `https://` |
| `ACR_NAMESPACE` | ACR 命名空间，例如 `powu` |
| `ACR_USERNAME` | ACR 登录用户名 |
| `ACR_PASSWORD` | ACR 登录密码或访问凭证 |
| `ECS_HOST` | ECS 公网 IP，例如 `<ECS公网IP>` |
| `ECS_USER` | SSH 用户名，例如 `root` |
| `ECS_SSH_KEY` | 能登录 ECS 的 SSH 私钥全文 |

私钥、ACR 密码只能粘贴到 GitHub Secrets，不能写入 `.env`、Compose、Actions 文件或提交到 Git。

## ECS 首次准备

在 ECS Workbench 或已有 SSH 会话中执行一次：

```bash
apt-get update
apt-get install -y docker.io docker-compose curl
systemctl enable --now docker
mkdir -p /opt/powu
docker --version
docker-compose version
```

确保 `ECS_SSH_KEY` 对应的公钥已经在 ECS 用户的 `~/.ssh/authorized_keys` 中。当前 MVP 会直接监听 ECS 的 `0.0.0.0:3000`，需要在 ECS 安全组放行 TCP 3000；后续再换成 Nginx/Caddy 反向代理和域名。

## 验证与回滚

### ECS 安全组入方向

| 端口 | 协议 | 来源 | 用途 |
|---|---|---|---|
| 22 | TCP | 团队固定 IP 或必要范围 | GitHub Actions SSH 部署 |
| 3000 | TCP | 0.0.0.0/0（仅临时） | 公网访问 MVP |

比赛演示可以临时开放 3000。长期运行时应限制来源 IP，或改用 Nginx/Caddy 的 80/443 端口和域名。

合并到 `main` 后，在 GitHub 的 `Actions -> Deploy` 查看运行结果。成功后，ECS 上的验证命令为：

```bash
curl --fail http://101.201.101.252:3000/healthz
docker-compose --env-file /opt/powu/.env -f /opt/powu/docker-compose.yml ps
```

部署使用 commit SHA 镜像标签，便于回滚。将 `/opt/powu/.env` 中的 `ACR_IMAGE` 改为已知可用的旧 SHA 标签后执行：

```bash
docker-compose --env-file /opt/powu/.env -f /opt/powu/docker-compose.yml pull
docker-compose --env-file /opt/powu/.env -f /opt/powu/docker-compose.yml up -d
curl --fail http://101.201.101.252:3000/healthz
```

## 日常协同开发

每位队员从最新 main 创建自己的功能分支：

~~~bash
git switch main
git pull origin main
git switch -c feature/<姓名>-<功能>
~~~

开发完成后：

~~~bash
git add .
git commit -m "feat: <简短描述>"
git push -u origin feature/<姓名>-<功能>
~~~

随后创建 Pull Request，目标分支选择 main，等待 test 通过，由负责人检查后合并。合并完成后会自动部署 ECS。

不要多人共用同一个功能分支，也不要直接 push main。

## 故障排查

### ACR 登录或推送失败

- 检查 ACR_REGISTRY 是否为登录地址，且不带 https://
- 检查 ACR 固定密码是否正确
- 检查 ACR_NAMESPACE 和仓库名是否正确

### ECS SSH 失败

- ECS_HOST 必须是公网 IP，不能填 172.* 私网 IP
- ECS_USER 必须与公钥所在用户一致
- ECS_SSH_KEY 必须是完整私钥
- 公钥必须在 ECS 的 ~/.ssh/authorized_keys
- 安全组必须放行 TCP 22

### ECS 本机能访问，公网不能访问

在 ECS 执行：

~~~bash
ss -lntp | grep 3000
curl http://127.0.0.1:3000/healthz
~~~

如果本机成功、公网失败，通常是安全组没有放行 TCP 3000，或者规则来源范围不正确。

## 比赛现场最短清单

~~~text
[ ] 创建新的空 GitHub 仓库
[ ] 推送项目代码到 main
[ ] 邀请队员
[ ] 配置 main 分支保护和 test 必须通过
[ ] 创建 ACR powu 镜像仓库
[ ] 设置 ACR 固定密码
[ ] ECS 安装 docker.io、docker-compose、curl
[ ] ECS 写入 GitHub Actions 对应的 SSH 公钥
[ ] ECS 创建 /opt/powu
[ ] 安全组放行 TCP 22 和临时 TCP 3000
[ ] 配置 DEPLOY_ENABLED=true
[ ] 配置 7 个 GitHub Secrets
[ ] 创建测试 PR，确认 test 通过
[ ] 合并 main，确认 Deploy 通过
[ ] 公网访问 http://<ECS公网IP>:3000/healthz
~~~
