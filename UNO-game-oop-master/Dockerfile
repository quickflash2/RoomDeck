FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
COPY src/UNO2D/ /usr/share/nginx/html/UNO2D/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
