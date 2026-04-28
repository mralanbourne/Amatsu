#===============
# DOCKERFILE
# Minimal Alpine footprint, strips out development dependencies, 
# and automatically pulls the loading screen MP4s directly into the static folder.
#===============
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p static && \
    wget -q -O static/waiting.mp4 "https://github.com/mralanbourne/Yomi/releases/download/video/waiting.mp4" && \
    wget -q -O static/archive.mp4 "https://github.com/mralanbourne/Yomi/releases/download/video/archive.mp4"

EXPOSE 7002

CMD ["npm", "start"]
