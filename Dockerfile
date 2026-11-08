# 魔搭创空间 Docker：监听 0.0.0.0:7860，端口由平台约定
# 密钥不进镜像：MODEL_PROVIDERS / MODEL_KEYS / MODEL_NAME 全部走创空间「密文变量」
# 公开实例还需要（明文变量）：BRAIN=model（不设则整个 L12 走本地替身，这是故意的缺省）、
#   MODEL_NAMES（按位对应供应商的模型 id）、PRESENCE_MS（无人观看多久后停调模型，建议 45~60）。
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
