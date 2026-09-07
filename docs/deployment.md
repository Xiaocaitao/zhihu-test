# ACR + ECS 自动部署

## 部署链路

```text
合并到 main
  -> GitHub Actions 安装依赖、类型检查、运行测试
  -> 构建 Docker 镜像
  -> 推送 ACR（commit SHA + latest）
  -> SSH 到 ECS
  -> docker-compose pull/up
  -> ECS 本机请求 /healthz
```

工作流文件是 `.github/workflows/deploy.yml`。它只在 `main` push 或手动触发，并且只有仓库变量 `DEPLOY_ENABLED` 为 `true` 时才会真正部署。

## GitHub 一次性配置

进入仓库 `Settings -> Secrets and variables -> Actions`：

### Variables

| 名称 | 值 |
|---|---|
| `DEPLOY_ENABLED` | `true` |

### Secrets

| 名称 | 内容 |
|---|---|
| `ACR_REGISTRY` | ACR 登录地址，例如 `registry.cn-beijing.aliyuncs.com` |
| `ACR_NAMESPACE` | ACR 命名空间/用户名空间 |
| `ACR_USERNAME` | ACR 登录用户名 |
| `ACR_PASSWORD` | ACR 登录密码或访问凭证 |
| `ECS_HOST` | ECS 公网 IP，例如 `101.201.101.252` |
| `ECS_USER` | SSH 用户名，例如 `root` |
| `ECS_SSH_KEY` | 能登录 ECS 的 SSH 私钥全文 |

私钥、ACR 密码只能粘贴到 GitHub Secrets，不能写入 `.env`、Compose、Actions 文件或提交到 Git。

## ECS 首次准备

在 ECS Workbench 或已有 SSH 会话中执行一次：

```bash
apt-get update
apt-get install -y docker.io docker-compose curl
systemctl enable --now docker
docker --version
docker-compose version
```

确保 `ECS_SSH_KEY` 对应的公钥已经在 ECS 用户的 `~/.ssh/authorized_keys` 中。当前 MVP 会直接监听 ECS 的 `0.0.0.0:3000`，需要在 ECS 安全组放行 TCP 3000；后续再换成 Nginx/Caddy 反向代理和域名。

## 验证与回滚

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
