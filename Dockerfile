# 键盘焦点路线实验室运行镜像
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# 先拷贝依赖清单，充分利用 Docker 层缓存；有 lockfile 用 npm ci 复现安装
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 拷贝应用源码（server.js / public/ / test/）
COPY . .

EXPOSE 3000

# 默认端口 3000，可用 -e PORT=xxxx 覆盖
CMD ["node", "server.js"]
