FROM node:20-alpine
WORKDIR /usr/src/app

# 의존성 먼저 설치 (캐시 레이어 최적화)
COPY package*.json ./
RUN npm install --omit=dev

# 소스 복사
COPY . .

# 임시 파일 저장 디렉토리 생성
RUN mkdir -p /tmp/btr-output

EXPOSE 8080

CMD ["npm", "start"]
