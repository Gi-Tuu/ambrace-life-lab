# 魔搭创空间 Docker：监听 0.0.0.0:7860，端口由平台约定
# 密钥不进镜像：MODEL_PROVIDERS / MODEL_KEYS / MODEL_NAME 全部走创空间「密文变量」
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    DATA_DIR=/data

# 只需要这四样：服务器、引擎、前端、固定历史起点
COPY serve.mjs ./
COPY life/ ./life/
COPY web/ ./web/
COPY seed/ ./seed/

# 世界状态必须落在持久卷上；容器临时文件系统随时会没
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7860/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "serve.mjs"]
