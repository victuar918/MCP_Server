Base image
FROM node:20-alpine

Create app directory
WORKDIR /usr/src/app

Install dependencies
COPY package*.json ./
RUN npm install --only=production

Bundle app source
COPY . .

Expose port (Cloud Run uses 8080 by default)
EXPOSE 8080

Start the server
CMD [ "npm", "start" ]