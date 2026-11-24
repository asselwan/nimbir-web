FROM nginx:alpine
# Server config (deploy-freshness contract, prm_28626d25 v49) must be the
# server's own config, not a file published under the document root.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
RUN rm -f /usr/share/nginx/html/nginx.conf
EXPOSE 80
