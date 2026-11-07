#!/usr/bin/env python3
"""Offline structural/fixture checks. Requires jsonschema==4.26.0; no service calls."""
import argparse
import copy
import json
import re
from datetime import datetime, date
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import urlparse
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
FORMATS = FormatChecker()

@FORMATS.checks('date-time', raises=(ValueError, TypeError))
def is_timestamp(value):
    return not isinstance(value, str) or datetime.fromisoformat(value.replace('Z', '+00:00')) is not None

@FORMATS.checks('date', raises=(ValueError, TypeError))
def is_date(value):
    return not isinstance(value, str) or date.fromisoformat(value) is not None

@FORMATS.checks('uri', raises=(ValueError, TypeError))
def is_uri(value):
    return not isinstance(value, str) or bool(urlparse(value).scheme and urlparse(value).netloc)

def read(path):
    return json.loads(path.read_text())

def walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

def rewrite_refs(value, prefix, replacement):
    if isinstance(value, dict):
        return {key: (child.replace(prefix, replacement, 1) if key == '$ref' and child.startswith(prefix)
                      else rewrite_refs(child, prefix, replacement)) for key, child in value.items()}
    if isinstance(value, list):
        return [rewrite_refs(child, prefix, replacement) for child in value]
    return value

def check_references(path, document):
    for node in walk(document):
        if not isinstance(node, dict) or '$ref' not in node:
            continue
        ref = node['$ref']
        filename, _, pointer = ref.partition('#')
        target_path = (path.parent / filename).resolve() if filename else path
        assert target_path.is_relative_to(ROOT), f'Nonlocal reference: {ref}'
        target = read(target_path) if filename else document
        for segment in pointer.lstrip('/').split('/') if pointer else []:
            target = target[segment.replace('~1', '/').replace('~0', '~')]

def inventory(public, internal, grpc):
    rows = []
    for is_public, spec in [(True, public), (False, internal)]:
        for path, methods in spec['paths'].items():
            for method, op in methods.items():
                rows.append({'operationId': op['operationId'], 'owner': op['x-owner'], 'protocol': 'REST',
                             'surface': 'PUBLIC' if is_public else 'INTERNAL', 'method': method.upper(),
                             'path': ('/api' if is_public else '/internal/v1') + path,
                             'requirements': op['x-requirements']})
    for op in grpc['operations']:
        rows.append({'operationId': op['operationId'], 'owner': op['owner'], 'protocol': 'GRPC',
                     'surface': 'INTERNAL', 'method': 'UNARY', 'path': '/' + op['service'] + '/' + op['rpc'],
                     'requirements': op['requirements']})
    return sorted(rows, key=lambda row: row["operationId"])

def check_operations(spec, public, requirements):
    for path, methods in spec['paths'].items():
        for method, op in methods.items():
            names = re.findall(r'{(\w+)}', path)
            params = op.get('parameters', [])
            assert sorted(names) == sorted(p['name'] for p in params if p['in'] == 'path')
            assert len({(p['in'], p['name']) for p in params}) == len(params)
            assert op['x-requirements'], op['operationId']
            for req in op['x-requirements']:
                assert req in requirements, f'Unknown requirement {req} on {op["operationId"]}'
            if not public:
                assert op['x-authorized-callers'] and op['security'] == [{'WorkloadBearer': []}]
                assert not path.startswith('/demo/')
            if public and op['x-idempotency'] == 'REQUIRED':
                assert any(p['name'] == 'Idempotency-Key' and p['required'] for p in params)
            for response in op['responses'].values():
                assert 'X-Request-Id' in response['headers']
            if '202' in op['responses'] and op['operationId'] != 'requestPasswordReset':
                assert 'Location' in op['responses']['202']['headers']

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--collection', type=Path)
    parser.add_argument('--bundle-dir', type=Path)
    parser.add_argument('--write-inventory', action='store_true')
    args = parser.parse_args()
    shared = read(ROOT / 'schemas/v1.json')
    events = read(ROOT / 'schemas/events.v1.json')
    public, internal = (read(ROOT / name) for name in ['public.openapi.json', 'internal.openapi.json'])
    for filename in ['schemas/v1.json', 'schemas/events.v1.json', 'public.openapi.json', 'internal.openapi.json']:
        check_references(ROOT / filename, read(ROOT / filename))
    Draft202012Validator.check_schema(shared)
    Draft202012Validator.check_schema(events)
    merged_event = rewrite_refs(events, './v1.json#/$defs/', '#/$defs/')
    merged_event['$defs'] = shared['$defs']
    Draft202012Validator.check_schema(merged_event)
    grpc = read(ROOT / 'grpc/operations.v1.json')
    rpc_messages = read(ROOT / 'grpc/messages.v1.json')
    Draft202012Validator.check_schema(rpc_messages)
    check_references(ROOT / 'grpc/messages.v1.json', rpc_messages)
    resources = []
    for path in [ROOT / 'schemas/v1.json', ROOT / 'grpc/messages.v1.json']:
        contents = dict(read(path), **{'$id': path.as_uri()})
        resources.append((path.as_uri(), Resource.from_contents(contents)))
    registry = Registry().with_resources(resources)
    def rpc_validator(reference):
        filename, _, pointer = reference.partition('#')
        path = (ROOT / 'grpc' / filename).resolve()
        assert path.is_relative_to(ROOT)
        return Draft202012Validator({'$ref': path.as_uri() + '#' + pointer}, registry=registry, format_checker=FORMATS)
    by_rpc = {op['operationId']: op for op in grpc['operations']}
    assert len(by_rpc) == len(grpc['operations']) == 20
    assert {op['owner'] for op in grpc['operations']} == {'auth','tutor','booking','wallet','review'}
    assert len({op['service'] + '/' + op['rpc'] for op in grpc['operations']}) == 20
    rpc_cases = read(ROOT / 'grpc/examples.v1.json')
    assert {case['operationId'] for case in rpc_cases['operations']} == set(by_rpc)
    for op in grpc['operations']:
        assert op['authorizedCallers'] and op['requirements'] and op['deadlineMs'] in [2000,3000]
        assert (ROOT / 'grpc' / op['proto']).is_file()
        for direction in ['request','response']:
            rpc_validator(op[direction+'Schema'])
    for case in rpc_cases['operations']:
        op = by_rpc[case['operationId']]
        for direction in ['request','response']:
            rpc_validator(op[direction+'Schema']).validate(case[direction])
        request, response = case['request'], case['response']
        for key in ['operationId','bookingId','userId']:
            if key in request and key in response:
                assert request[key] == response[key], (case['operationId'], key)
        if case['operationId'] == 'getRatingSummaries':
            assert request['subjectIds'] == [item['subjectId'] for item in response['items']]
        if case['operationId'] in ['getAvailability','batchGetAvailability']:
            queries = [request['query']] if 'query' in request else request['queries']
            for query in queries:
                delta = datetime.fromisoformat(query['to']) - datetime.fromisoformat(query['from'])
                assert 0 < delta.total_seconds() <= 93*86400
            if 'results' in response:
                assert [item['queryIndex'] for item in response['results']] == list(range(len(queries)))
    for case in rpc_cases['invalidCases']:
        op = by_rpc[case['operationId']]
        assert list(rpc_validator(op[case['direction']+'Schema']).iter_errors(case['value'])), case['name']
    print(f'PASS: {len(grpc["operations"])} gRPC methods, 40 request/response schema fixtures and {len(rpc_cases["invalidCases"])} invalid gRPC fixtures.')
    cases = read(ROOT / 'examples/cases.json')
    for case in cases['schemaCases']:
        schema = merged_event if case['schema'] == 'event' else dict(shared, **{'$ref': '#/$defs/' + case['schema']})
        errors = list(Draft202012Validator(schema, format_checker=FORMATS).iter_errors(case['value']))
        assert (not errors) == case['valid'], f'{case["name"]}: {[e.message for e in errors][:2]}'
    quant = lambda n: n.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    for case in cases['moneyCases']:
        paid = quant(Decimal(case['hourlyRate']) * case['slots'] / 2)
        fee = quant(paid * Decimal('0.15'))
        assert (paid, fee, paid - fee, quant(paid * Decimal('0.70'))) == tuple(Decimal(case[k]) for k in ['paid','fee','net','lateRefund'])
    for case in cases['cancellationBoundaryCases']:
        seconds = (datetime.fromisoformat(case['startsAt']) - datetime.fromisoformat(case['admittedAt'])).total_seconds()
        assert (None if seconds <= 0 else 100 if seconds > 86400 else 70) == case['refundPercent']
    for case in cases['refundCapCases']:
        assert Decimal(case['paid']) - Decimal(case['priorRefunds']) == Decimal(case['remaining']) >= 0
    requirements_text = (REPO / 'docs/requirements.md').read_text()
    requirements = set(re.findall(r'\b(?:AUTH-\d+|UC\d{2}-\d+|SUP-\d+|Q-\d+)\b', requirements_text))
    check_operations(public, True, requirements)
    check_operations(internal, False, requirements)
    rows = inventory(public, internal, grpc)
    rpc_ids = {op['operationId'] for op in grpc['operations']}
    assert not rpc_ids.intersection(op['operationId'] for methods in internal['paths'].values() for op in methods.values()), 'Duplicate REST/gRPC authority'
    assert sum(len(methods) for methods in internal['paths'].values()) == 8
    for methods in internal['paths'].values():
        for op in methods.values():
            assert op['x-authorized-callers'] == ['gateway']
    for op in grpc['operations']:
        assert set(op['requirements']) <= requirements
    assert len({r['operationId'] for r in rows}) == len(rows)
    # Keep the four implementation handoffs synchronized with both transports.
    assignments = {'saint': {'auth','gateway'}, 'ideal': {'tutor','review'},
                   'santa': {'booking','messaging'}, 'p': {'wallet','notification'}}
    handoff_ids = []
    for member, owners in assignments.items():
        text = (REPO / 'docs/handoffs' / (member + '.md')).read_text()
        entries = re.findall(r'^\| (\w+) \| (REST|GRPC) \| (PUBLIC|INTERNAL) \| `([^`]+)` \| `([A-Z]+) ([^`]+)` \|$', text, re.M)
        expected = {(r['owner'],r['protocol'],r['surface'],r['operationId'],r['method'],r['path']) for r in rows if r['owner'] in owners}
        assert len(entries) == len(expected) and set(entries) == expected, member + ' handoff is stale'
        handoff_ids.extend(entry[3] for entry in entries)
    assert len(handoff_ids) == len(set(handoff_ids)) == len(rows)
    covered = {req for row in rows for req in row['requirements']}
    behavior_requirements = {r for r in requirements if not r.startswith('Q-')}
    assert behavior_requirements <= covered, f'Missing behavior annotation: {behavior_requirements - covered}'
    if args.collection:
        import yaml
        from urllib.parse import urlsplit, parse_qsl
        seen = set()
        definition = yaml.safe_load((args.collection / '.resources/definition.yaml').read_text())
        variables = definition['variables']
        assert variables['bearerToken'] == '', 'Never commit a runtime bearer token'
        for file in args.collection.rglob('*.request.yaml'):
            request = yaml.safe_load(file.read_text())
            raw_path = request['url'].split('?', 1)[0].replace('{{baseUrl}}', '')
            path = re.sub(r':(\w+)', r'{\1}', raw_path)
            method = request['method'].lower()
            operation = public['paths'][path][method]
            assert (path, method) not in seen
            seen.add((path, method))
            if 'requestBody' in operation:
                name = operation['requestBody']['content']['application/json']['schema']['$ref'].split('/')[-1]
                body = json.loads(request['body']['content'])
                schema = dict(shared, **{'$ref': '#/$defs/' + name})
                Draft202012Validator(schema, format_checker=FORMATS).validate(body)
            expected_queries = [(q['key'], str(q['value'])) for q in request.get('queryParams', []) if not q.get('disabled')]
            actual_queries = parse_qsl(request['url'].partition('?')[2], keep_blank_values=True)
            assert expected_queries == actual_queries, str(file)
            assert all(v['value'].strip('{}') in variables or not v['value'].startswith('{{') for v in request.get('pathVariables', []))
        assert len(seen) == sum(len(methods) for methods in public['paths'].values())
        print(f'PASS: all {len(seen)} target collection requests match public operations; JSON bodies validate and query strings agree.')
    assert {f'UC{i:02d}' for i in range(1,10)} <= {r.split('-')[0] for r in covered}
    if args.write_inventory:
        (ROOT / 'operation-map.json').write_text(json.dumps(rows, indent=2) + '\n')
    assert rows == read(ROOT / 'operation-map.json'), 'Stale route inventory; use --write-inventory'
    if args.bundle_dir:
        args.bundle_dir.mkdir(parents=True, exist_ok=True)
        defs = rewrite_refs(shared['$defs'], '#/$defs/', '#/components/schemas/')
        for name, spec in [('public', public), ('internal', internal)]:
            bundle = copy.deepcopy(spec)
            bundle['components']['schemas'] = defs
            (args.bundle_dir / f'{name}.openapi.json').write_text(json.dumps(bundle, indent=2) + '\n')
    print(f'PASS: {len(shared["$defs"])} shared schemas, {len(events["oneOf"])} event variants, {len(rows)} unique REST/gRPC operations, all nine use cases, {len(cases["schemaCases"])} schema fixtures and {sum(len(cases[k]) for k in ["moneyCases","cancellationBoundaryCases","refundCapCases"])} money/time fixtures. Local references and route inventory agree.')
    print('These checks do not prove runtime, concurrency, provider, UI or deployment acceptance.')

if __name__ == '__main__':
    main()
