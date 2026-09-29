// Minimal Web Push: an empty "tickle" signed with VAPID (no payload, so no encryption).
// The site's service worker then reads sets.json and shows the newest set.

const enc = new TextEncoder();
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let signingKey;
async function vapidHeader(endpoint, env) {
  signingKey ??= await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT,
      }),
    ),
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export async function sendPush(endpoint, env) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(endpoint, env),
      TTL: String(3 * 24 * 3600),
      Urgency: "normal",
      "Content-Length": "0",
    },
  });
  return res.status;
}
