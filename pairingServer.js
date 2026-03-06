import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

export class PairingServer {
    constructor(callback) {
        this._callback = callback;
        this._server = new Soup.Server();

        this._server.add_handler('/announce', (server, msg, path, query) => {
            if (msg.get_method() !== 'POST') {
                msg.set_status(Soup.Status.METHOD_NOT_ALLOWED, null);
                return;
            }

            try {
                const body = msg.get_request_body();
                const bytes = body.flatten();
                const data = JSON.parse(new TextDecoder().decode(bytes.toArray()));

                if (data.ip) {
                    console.log(`PairingServer: Received announcement from ${data.ip}`);
                    this._callback(data.ip);
                    const responseBytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify({ status: 'ok' })));
                    msg.set_response('application/json', responseBytes);
                    msg.set_status(Soup.Status.OK, null);
                } else {
                    msg.set_status(Soup.Status.BAD_REQUEST, null);
                }
            } catch (e) {
                console.error(`PairingServer Error: ${e.message}`);
                msg.set_status(Soup.Status.INTERNAL_SERVER_ERROR, null);
            }
        });
    }

    start() {
        try {
            // Try to listen on all interfaces on port 8081
            this._server.listen_all(8081, Soup.ServerListenOptions.IPV4_ONLY);
            console.log('PairingServer: Listening on port 8081');
            return true;
        } catch (e) {
            console.error(`PairingServer: Failed to start: ${e.message}`);
            return false;
        }
    }

    stop() {
        if (this._server) {
            this._server.disconnect();
            console.log('PairingServer: Stopped');
        }
    }
}
