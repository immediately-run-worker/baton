# gen.py — test/fixtures/sshsig/ssh-keygen.json: requests signed by OpenSSH's own `ssh-keygen -Y sign`
# (ed25519 and P-256 keys made for the run and thrown away), so the verifier is proven against
# the tool workers sign with, not only the test signer (R3-1239). Run from a scratch directory.
import subprocess, json, base64, hashlib, os
created = 1792065600  # 2026-10-15T12:00:00Z
out = {}
for name, t in [('ed25519', ['-t','ed25519']), ('ecdsa', ['-t','ecdsa','-b','256'])]:
    subprocess.run(['ssh-keygen', *t, '-N', '', '-C', f'fixture-{name}', '-f', name, '-q'], check=True)
    pub = open(name + '.pub').read().strip()
    fp = subprocess.run(['ssh-keygen','-lf',name+'.pub'],capture_output=True,text=True).stdout.split()[1]
    for case, method, path, body, ns in [('post', 'POST', '/v1/runner/heartbeat', '{"a":1}', 'baton-request'), ('get', 'GET', '/v1/runner/mode?repository=docs', '', 'baton-request'), ('git', 'GET', '/v1/runner/mode?repository=docs', '', 'git')]:
        digest = 'sha-256=:' + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + ':'
        nonce = base64.urlsafe_b64encode(os.urandom(16)).decode().rstrip('=')
        params = f'("@method" "@authority" "@path" "@query" "content-digest");created={created};nonce="{nonce}";keyid="{fp}";tag="baton-request"'
        p, _, q = path.partition('?')
        base = '\n'.join([f'"@method": {method}', '"@authority": baton.immediately.run', f'"@path": {p}', f'"@query": ?{q}', f'"content-digest": {digest}', f'"@signature-params": {params}'])
        open('base','w').write(base)
        subprocess.run(['ssh-keygen','-Y','sign','-f',name,'-n',ns,'-q','base'],check=True)
        arm = open('base.sig').read().strip().splitlines(); os.remove('base.sig')
        blob = ''.join(l for l in arm if not l.startswith('-----'))
        out[f'{name}-{case}'] = {'publicKey': pub, 'method': method, 'url': 'https://baton.immediately.run' + path, 'body': body,
            'headers': {'Content-Digest': digest, 'Signature-Input': 'sig1=' + params, 'Signature': f'sig1=:{blob}:'}, 'created': created}
json.dump(out, open('/home/user/baton/test/fixtures/sshsig/ssh-keygen.json','w'), indent=2)
print(list(out))
