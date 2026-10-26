# ---- 构建阶段：安装依赖、生成前端静态文件，并裁剪为生产依赖 ----
FROM node:24-alpine AS build
WORKDIR /app
# 小内存服务器上限制 V8 堆，避免 Rollup 构建时触发 OOM / 长时间 swap
ENV NODE_OPTIONS=--max-old-space-size=1024
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- 运行阶段：直接复用构建阶段裁剪后的依赖，不再重复安装 ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
# SQLite 数据目录由非 root 的 node 用户写入
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js", "--production"]
