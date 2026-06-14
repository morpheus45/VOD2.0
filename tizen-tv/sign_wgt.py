#!/usr/bin/env python3
"""
sign_wgt.py — Signe un package Tizen .wgt avec W3C Widget Digital Signatures
Crée author-signature.xml + signature1.xml identiques à ceux de Tizen Studio.

Usage:
  python sign_wgt.py --duid <DUID> --input <wgt_in> --output <wgt_out>
"""

import os, sys, zipfile, hashlib, base64, datetime, argparse
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from lxml import etree

DSI = "http://www.w3.org/2000/09/xmldsig#"
XA  = "http://uri.etsi.org/01903/v1.1.1#"
SHA256_URI = "http://www.w3.org/2001/04/xmlenc#sha256"
RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
C14N       = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"

def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()

def sha256b64(data: bytes) -> str:
    return b64(hashlib.sha256(data).digest())

def generate_key_and_cert(duid: str):
    """
    Génère une clé RSA-2048 + certificat auto-signé.
    Le DUID est inclus dans le CN du certificat distributeur.
    """
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    # Le CN contient le DUID — c'est ce que Samsung vérifie en mode développeur
    cn = duid if duid else "PIPSILY TV Developer"
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME,        cn),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME,  "PIPSILY TV"),
        x509.NameAttribute(NameOID.COUNTRY_NAME,       "CA"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now.replace(year=now.year + 10))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    return key, cert


def _c14n(el: etree._Element) -> bytes:
    """Inclusive C14N of a single element."""
    import io
    stream = io.BytesIO()
    etree.ElementTree(el).write_c14n(stream, exclusive=False, with_comments=False)
    return stream.getvalue()


def build_signature(sig_id: str, refs: list, cert, key, signing_time: str) -> bytes:
    """
    Build a complete Signature XML element and return it as UTF-8 bytes.
    refs = list of (uri, sha256_b64_digest)
    """
    nsmap_ds = {None: DSI}
    nsmap_xa = {"xades": XA, "ds": DSI}

    # ── Object / QualifyingProperties / SignedProperties ──────────────────────
    obj_el = etree.Element(f"{{{DSI}}}Object", Id=f"{sig_id}Object")

    qp = etree.SubElement(obj_el, f"{{{XA}}}QualifyingProperties",
                          nsmap={"xades": XA, "ds": DSI},
                          Target=f"#{sig_id}")

    sp = etree.SubElement(qp, f"{{{XA}}}SignedProperties",
                          Id=f"{sig_id}SignedProperties")

    ssp = etree.SubElement(sp, f"{{{XA}}}SignedSignatureProperties")

    st = etree.SubElement(ssp, f"{{{XA}}}SigningTime")
    st.text = signing_time

    sc   = etree.SubElement(ssp,  f"{{{XA}}}SigningCertificate")
    c    = etree.SubElement(sc,   f"{{{XA}}}Cert")
    cd   = etree.SubElement(c,    f"{{{XA}}}CertDigest")
    cdm  = etree.SubElement(cd,   f"{{{DSI}}}DigestMethod",
                                  Algorithm=SHA256_URI)
    cdv  = etree.SubElement(cd,   f"{{{DSI}}}DigestValue")
    cdv.text = b64(cert.fingerprint(hashes.SHA256()))

    is_el = etree.SubElement(c,   f"{{{XA}}}IssuerSerial")
    xin   = etree.SubElement(is_el, f"{{{DSI}}}X509IssuerName")
    xin.text = cert.issuer.rfc4514_string()
    xsn   = etree.SubElement(is_el, f"{{{DSI}}}X509SerialNumber")
    xsn.text = str(cert.serial_number)

    # Canonicalize SignedProperties to compute its digest
    sp_c14n  = _c14n(sp)
    sp_digest = sha256b64(sp_c14n)

    # ── SignedInfo ─────────────────────────────────────────────────────────────
    si = etree.Element(f"{{{DSI}}}SignedInfo", nsmap=nsmap_ds)

    cm = etree.SubElement(si, f"{{{DSI}}}CanonicalizationMethod", Algorithm=C14N)
    sm = etree.SubElement(si, f"{{{DSI}}}SignatureMethod",         Algorithm=RSA_SHA256)

    for uri, digest in refs:
        ref = etree.SubElement(si, f"{{{DSI}}}Reference", URI=uri)
        dm  = etree.SubElement(ref, f"{{{DSI}}}DigestMethod", Algorithm=SHA256_URI)
        dv  = etree.SubElement(ref, f"{{{DSI}}}DigestValue")
        dv.text = digest

    # Reference for SignedProperties
    sp_ref = etree.SubElement(si, f"{{{DSI}}}Reference",
                              Type=f"{XA}SignedProperties",
                              URI=f"#{sig_id}SignedProperties")
    sp_ref_dm = etree.SubElement(sp_ref, f"{{{DSI}}}DigestMethod", Algorithm=SHA256_URI)
    sp_ref_dv = etree.SubElement(sp_ref, f"{{{DSI}}}DigestValue")
    sp_ref_dv.text = sp_digest

    # Sign c14n(SignedInfo)
    si_c14n = _c14n(si)
    sig_val  = b64(key.sign(si_c14n, padding.PKCS1v15(), hashes.SHA256()))

    # ── Assemble Signature root ───────────────────────────────────────────────
    sig_root = etree.Element(f"{{{DSI}}}Signature", Id=sig_id, nsmap=nsmap_ds)

    sig_root.append(si)

    sv_el = etree.SubElement(sig_root, f"{{{DSI}}}SignatureValue")
    sv_el.text = sig_val

    ki     = etree.SubElement(sig_root, f"{{{DSI}}}KeyInfo")
    x9data = etree.SubElement(ki,       f"{{{DSI}}}X509Data")
    x9cert = etree.SubElement(x9data,   f"{{{DSI}}}X509Certificate")
    x9cert.text = b64(cert.public_bytes(serialization.Encoding.DER))

    sig_root.append(obj_el)

    return etree.tostring(sig_root, pretty_print=True,
                          xml_declaration=True, encoding="UTF-8")


def sign_wgt(wgt_in: str, wgt_out: str, duid: str = "", p12_out: str | None = None):
    print(f"[1/4] Generation cle RSA-2048 + certificat (DUID: {duid or 'non specifie'})...")
    key, cert = generate_key_and_cert(duid)

    if p12_out:
        p12_data = pkcs12.serialize_key_and_certificates(
            name=b"PIPSILY TV",
            key=key, cert=cert, cas=None,
            encryption_algorithm=serialization.BestAvailableEncryption(b"pipsily-dev")
        )
        with open(p12_out, "wb") as f:
            f.write(p12_data)
        print(f"    Certificat sauvegarde : {p12_out}")

    signing_time = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    print(f"[2/4] Lecture du WGT : {wgt_in}")
    with zipfile.ZipFile(wgt_in, "r") as zf:
        names = sorted(
            n for n in zf.namelist()
            if n not in ("author-signature.xml", "signature1.xml")
        )
        if any(n.startswith('/') or '..' in n for n in names):
            print("ERREUR : entrées zip invalides détectées (path traversal)", file=sys.stderr)
            sys.exit(1)
        contents = {n: zf.read(n) for n in names}

    refs = [(n, sha256b64(contents[n])) for n in names]
    print(f"    {len(names)} fichiers a signer")

    print("[3/4] Creation author-signature.xml...")
    author_xml = build_signature("AuthorSignature", refs, cert, key, signing_time)

    print("[3/4] Creation signature1.xml (distributeur avec DUID)...")
    dist_refs  = refs + [("author-signature.xml", sha256b64(author_xml))]
    dist_xml   = build_signature("DistributorSignature", dist_refs, cert, key, signing_time)

    print(f"[4/4] Ecriture WGT signe : {wgt_out}")
    with zipfile.ZipFile(wgt_out, "w", zipfile.ZIP_DEFLATED) as zf:
        for n in names:
            zf.writestr(n, contents[n])
        zf.writestr("author-signature.xml", author_xml)
        zf.writestr("signature1.xml", dist_xml)

    size = os.path.getsize(wgt_out) / 1024
    print(f"\nSUCCES — WGT signe ({size:.0f} Ko)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Signe un .wgt Tizen avec le DUID de la TV")
    parser.add_argument("--duid",   required=True,  help="DUID de la TV Samsung (ex: 1ABCD1234567EF)")
    parser.add_argument("--input",  required=True,  help="Chemin du .wgt non-signe (PIPSILY-TV.wgt)")
    parser.add_argument("--output", required=True,  help="Chemin du .wgt signe en sortie")
    parser.add_argument("--p12",    default=None,   help="Optionnel : sauvegarder le .p12")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"ERREUR : fichier introuvable : {args.input}", file=sys.stderr)
        sys.exit(1)

    sign_wgt(args.input, args.output, duid=args.duid, p12_out=args.p12)
