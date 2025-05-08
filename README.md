Backend server scripts for Hyper-Reflector

Requirements to run:

You'll need to create a keys folder in the working directory and two additional files.

/keys

- server.ts

```
const COTURN_IP = SERVER_IP_STRING // this is the server IP, i suggest running this locally or on a cloud server
const COTURN_PORT = SERVER_PORT  // this is the server port
const API_PORT = API_PORT -- this is the express servers port

module.exports = { COTURN_IP, COTURN_PORT, API_PORT }

```

- service_account_key.json
  // service account key will come from google cloud platform, and you'll need this to host the firebase server.
  // you can create your own firebase account for local testing and use that service_account_key.json
