import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

const SMS_URL = 'http://192.168.1.81:8080/sms';

/**
 * Fetch SMS messages from the phone server
 * @returns {Promise<Array>}
 */
export async function fetchSMS() {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session();
        const message = Soup.Message.new('GET', SMS_URL);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (message.status_code !== 200) {
                    reject(new Error(`Failed to fetch SMS: ${message.reason_phrase}`));
                    return;
                }

                const decoder = new TextDecoder('utf-8');
                const text = decoder.decode(bytes.toArray());
                const data = JSON.parse(text);
                resolve(data);
                console.error(data)
            } catch (e) {
                console.log(e);
                reject(e);
            }
        });
    });
}
