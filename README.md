# like-direct — 反代版（无 Cloudflare Tunnel）

为什么做这个版本：Abasthan 的容器出站连不上 Cloudflare 的隧道边缘
（`region1.argotunnel.com:443` 全部 `Connection refused`），所以
cloudflared 永远注册不上，隧道永远离线。反代版不再走隧道，
客户端直接连平台自己的域名，流量由平台入口进来，再由本服务
把 WebSocket 转发给本地 Xray。

```
客户端 --TLS--> <DIRECT_DOMAIN>:443（平台入口）
       --plain--> 本服务 $PORT
       --WS upgrade--> 127.0.0.1:8001（Xray）
       --outbound--> 互联网
```

## 文件

- `server.js` — 反代服务器 + 启动 Xray + 生成订阅（从零写的，无隧道、无 Telegram、无任何内置 token）
- `package.json` — 无任何依赖，`npm install` 只是走个过场
- `index.html` — 首页
- `config.json` — 启动时由 `server.js` 自动生成，不用手写

## 部署到 Abasthan（新仓库）

1. 在 GitHub 新建一个仓库，例如 `like-direct`，把这三个文件
   `server.js`、`package.json`、`index.html` 传上去。
   （网页上传即可：仓库页 → Add file → Upload files）
2. 在 Abasthan 新建一个 **Web Service**，选这个新仓库，分支 `main`。
   或者在原 `like` 服务里把仓库换成这个新仓库。
3. 设置：
   - Build Command：
     ```
     npm install && curl -L -o Xray-linux-64.zip https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip && unzip -o Xray-linux-64.zip xray && chmod +x xray
     ```
   - Start Command：
     ```
     npm run start
     ```
4. 环境变量（Environment Variables，记得挂到服务上，见之前
   Environments & Groups 的教训）：
   - `UUID` = 新生成一个 UUID（不要用原来的默认 UUID）
   - `DIRECT_DOMAIN` = 这个服务的域名，例如
     `provider-each-shark.abasthan.app`
     （新建服务的话，换成新服务的域名）
   - `NAME` = 可选，节点名字，例如 `Direct`
   - 不需要 `ARGO_AUTH`、`ARGO_DOMAIN`、`BOT_TOKEN`、`CHAT_ID`
5. 重新部署。日志里应出现：
   ```
   Direct reverse-proxy server listening on 3000
   Domain: provider-each-shark.abasthan.app
   Subscription: /sub
   ```
6. 订阅地址：
   ```
   https://<你的域名>/sub
   ```
   里面是 3 条节点：VLESS / VMESS / TROJAN，地址、SNI、host
   都是你的 Abasthan 域名，端口 443，路径分别是
   `/vless-argo`、`/vmess-argo`、`/trojan-argo`。

## 本地自测（已在 Linux 上测过）

```
# 先下载 Xray（和上面 Build Command 同一个版本）
curl -L -o Xray-linux-64.zip https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip
unzip -o Xray-linux-64.zip xray && chmod +x xray

UUID=$(python3 -c "import uuid; print(uuid.uuid4())") \
DIRECT_DOMAIN=127.0.0.1 PORT=3000 node server.js
```

再开一个终端：

```
curl -s http://127.0.0.1:3000/sub | base64 -d
# 应看到 3 行，vless://、vmess://、trojan://，地址都是 127.0.0.1

curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "http://127.0.0.1:3000/vless-argo?ed=2560"
# 应返回 HTTP/1.1 101 Switching Protocols，说明 WS 已透传到 Xray
```

## 注意

- Abasthan 免费版 90 分钟无流量会休眠，休眠后第一次访问要等
  它唤醒，这一点反代版也一样，换平台才能根治。
- UUID 泄露了就换一个，重新部署即可。
- 不要把这个仓库的 `config.json` 手动提交上去，它是启动时生成的。
