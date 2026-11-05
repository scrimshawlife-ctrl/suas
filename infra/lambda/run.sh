#!/bin/sh
# Entry for the AWS Lambda Web Adapter (handler "run.sh"): start the API server, which
# listens on SUAS_HTTP_HOST:SUAS_HTTP_PORT; the adapter forwards each invocation to it.
exec node api.mjs
