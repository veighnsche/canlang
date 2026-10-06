#!/usr/bin/env python3
"""Independent exact-arithmetic outcome probe for the C02 numeric-ID boundary."""
import argparse
import decimal
import fractions
import hashlib
import json
from pathlib import Path
import re
import subprocess


def frame(body):
    data = body.encode('utf-8')
    return f'Content-Length: {len(data)}\r\n\r\n'.encode() + data


def bodies(wire):
    while wire:
        header, wire = wire.split(b'\r\n\r\n', 1)
        length = int(header.removeprefix(b'Content-Length: '))
        body, wire = wire[:length], wire[length:]
        assert len(body) == length
        yield body.decode('utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('binary', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    # Decimal parses spelling; Fraction supplies an independent rational oracle.
    # Exponents here are finite (-20..20), unrelated to production's scan/scale algorithm.
    coefficients = ['0', '-0', '1', '-1', '0.1', '-0.1', '1.0000000000000000001',
                    '2147483647', '-2147483648', '2147483648', '-2147483649',
                    '21474836470', '21474836480', '1000', '0.0000000001', '9999999999']
    cases = [f'{c}e{e:+d}' for c in coefficients for e in range(-20, 21)]
    expected = []
    for raw in cases:
        value = fractions.Fraction(decimal.Decimal(raw))
        expected.append(value.denominator == 1 and -(2**31) <= value <= 2**31 - 1)
    initialize = '{"jsonrpc":"2.0","id":"oracle-init","method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}'
    requests = [initialize] + ['{"jsonrpc":"2.0","id":' + raw + ',"method":"oracle/unknown","params":{}}' for raw in cases]
    result = subprocess.run([str(args.binary.resolve()), 'lsp'], input=b''.join(map(frame, requests)), capture_output=True, timeout=20, check=True)
    assert len(result.stdout) <= 1024 * 1024
    output = list(bodies(result.stdout))
    assert len(output) == len(requests)
    assert 'capabilities' in json.loads(output[0])['result']
    for raw, admitted, body in zip(cases, expected, output[1:]):
        parsed = json.loads(body, parse_int=decimal.Decimal, parse_float=decimal.Decimal)
        assert parsed['error']['code'] == (-32601 if admitted else -32600), (raw, body)
        # Byte fidelity uses the response text, independent of both Rust JSON routines.
        matched = re.search(r'"id":([^,]+),"error":', body)
        assert matched and matched[1] == (raw if admitted else 'null'), (raw, body)
    receipt = {'oracle': 'Python Decimal -> Fraction; fixed signed32 expected values and raw response ID bytes',
               'binary': str(args.binary.resolve()),
               'binary_sha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
               'cases': len(cases), 'accepted': sum(expected), 'rejected': len(cases) - sum(expected),
               'exit': result.returncode, 'stderr_empty': not result.stderr,
               'huge_exponent_cases': 'Permanent Rust process/unit witnesses cover saturating exponents and zero separately.'}
    args.output.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
