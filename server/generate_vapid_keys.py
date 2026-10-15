"""
Prints a new key pair for app notifications (Web Push / VAPID).

Run once, then put both lines into the trade-service environment
(docker-compose.yml) and restart the service:

    docker compose run --rm trade-service python generate_vapid_keys.py

Keep VAPID_PRIVATE_KEY secret. Changing the keys later means every device
has to turn notifications off and on again.
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


key = ec.generate_private_key(ec.SECP256R1())
private_raw = key.private_numbers().private_value.to_bytes(32, "big")
public_raw = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)

print(f'VAPID_PUBLIC_KEY: "{b64url(public_raw)}"')
print(f'VAPID_PRIVATE_KEY: "{b64url(private_raw)}"')
