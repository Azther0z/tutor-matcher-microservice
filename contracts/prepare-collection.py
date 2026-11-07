#!/usr/bin/env python3
"""Normalize ONLY a freshly generated target collection. Requires PyYAML.
Run after Postman generation, before adding maintained scripts or examples.
"""
import argparse
import copy
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlencode, quote
import yaml

class NoDateLoader(yaml.SafeLoader):
    pass

NoDateLoader.yaml_implicit_resolvers = {key: [(tag, pattern) for tag, pattern in values if tag != 'tag:yaml.org,2002:timestamp'] for key, values in copy.deepcopy(yaml.SafeLoader.yaml_implicit_resolvers).items()}

def load_yaml(text):
    return yaml.load(text, Loader=NoDateLoader)

ROOT = Path(__file__).resolve().parent
spec = json.loads((ROOT / 'public.openapi.json').read_text())
defs = json.loads((ROOT / 'schemas/v1.json').read_text())['$defs']
fixtures = json.loads((ROOT / 'examples/cases.json').read_text())['schemaCases']
ids = {name: f'{n:08x}-1111-4111-8111-111111111111' for n, name in enumerate(['userId','tutorId','subjectId','bookingId','operationId','draftId','submissionId','payoutId','accountId','reviewId','topupId','contentRef','transactionId','disputeId'], 1)}

def sample(schema, name=''):
    if '$ref' in schema:
        key = schema['$ref'].split('/')[-1]
        values = {'Id': ids.get(name, ids['operationId']), 'Timestamp':'2026-11-06T03:00:00.000Z', 'Date':'2026-11-06', 'Revision':'0', 'Amount':'100.00', 'PositiveAmount':'100.00', 'TransferAmount':'100.00', 'HourlyRate':'100.00', 'Email':'student@example.invalid', 'HttpsUrl':'https://example.invalid/synthetic-document', 'LearningArea':'mathematics', 'BangkokTime':'10:00'}
        if key in values:
            return values[key]
        example = next((x['value'] for x in fixtures if x['schema'] == key and x['valid']), None)
        return example if example is not None else sample(defs[key], name)
    if 'const' in schema:
        return schema['const']
    if 'enum' in schema:
        return schema['enum'][0]
    if 'oneOf' in schema or 'anyOf' in schema:
        return sample((schema.get('oneOf') or schema['anyOf'])[0], name)
    if 'allOf' in schema:
        return sample(schema['allOf'][0], name)
    if schema.get('type') == 'object':
        keys = schema.get('required', []) or list(schema.get('properties', {}))[:schema.get('minProperties', 0)]
        return {key: sample(schema['properties'][key], key) for key in keys}
    if schema.get('type') == 'array':
        return [sample(schema['items'], name) for _ in range(schema.get('minItems', 0))]
    if schema.get('type') in ['integer','number']:
        return schema.get('default', schema.get('minimum', 1))
    if schema.get('type') == 'boolean':
        return True
    if name in ['password','passwordConfirmation','currentPassword','newPassword','token']:
        return '<set-at-runtime>'
    return 'Synthetic example'[:schema.get('maxLength', 2000)]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('collection', type=Path)
    parser.add_argument('--fresh-generated', action='store_true', required=True,
                        help='Confirms this is disposable generator output, with no maintained examples/scripts.')
    args = parser.parse_args()
    collection = args.collection.resolve()
    assert collection.name == 'Tutor Matcher Target Public v1'
    assert (collection / '.resources/definition.yaml').is_file()
    count = 0
    for file in collection.rglob('*.request.yaml'):
        data = load_yaml(file.read_text())
        assert not data.get('scripts'), 'Refuse to normalize maintained scripts'
        path = data['url'].split('?', 1)[0].replace('{{baseUrl}}', '')
        path = re.sub(r':(\w+)', r'{\1}', path)
        op = spec['paths'][path][data['method'].lower()]
        if 'requestBody' in op:
            value = sample(op['requestBody']['content']['application/json']['schema'])
            data['body'] = {'type':'json', 'content':json.dumps(value, indent=2)}
        query_schemas = {p['name']:p['schema'] for p in op.get('parameters',[]) if p['in']=='query'}
        for query in data.get('queryParams', []):
            value = sample(query_schemas[query['key']], query['key'])
            query['value'] = str(value).lower() if isinstance(value, bool) else str(value)
            if query['key'] == 'to':
                query['value'] = '2026-11-07'
        pairs = [(q['key'], q['value']) for q in data.get('queryParams',[]) if not q.get('disabled')]
        data['url'] = data['url'].split('?',1)[0] + ('?' + urlencode(pairs, quote_via=quote) if pairs else '')
        for header in data.get('headers',[]):
            if header['key'] == 'X-Request-Id': header['value'] = '{{requestId}}'
            if header['key'] == 'Idempotency-Key': header['value'] = '{{idempotencyKey}}'
            if header['key'] == 'If-Match': header['value'] = '"{{revision}}"'
        if op['operationId'] == 'putAvailabilitySlot':
            # Default to creation; enable If-Match instead when editing a known slot.
            for header in data.get('headers',[]):
                if header['key'] == 'If-Match': header['disabled'] = True
                if header['key'] == 'If-None-Match': header.update(value='*', disabled=False)
        for variable in data.get('pathVariables',[]):
            name = variable['key']
            variable['value'] = {'owner':'booking','date':'2026-11-06','time':'10:00'}.get(name, '{{'+name+'}}')
        data.pop('examples', None) # Discard generic generated examples; validated fixtures own examples.
        data['description'] = data['description'].split('\nDerived target request.')[0] + '\nDerived target request. Use synthetic IDs and runtime credentials. See contracts/examples/cases.json; target behavior is not implemented yet.'
        file.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=120))
        count += 1
    # These directories contain only fresh generated example responses, often invalid for const/date schemas.
    for directory in collection.glob('*/.resources/*.resources'):
        shutil.rmtree(directory)
    definition_file = collection / '.resources/definition.yaml'
    definition = load_yaml(definition_file.read_text())
    definition['variables'].update(ids)
    definition['variables'].update(requestId='000000aa-1111-4111-8111-111111111111', idempotencyKey='000000bb-1111-4111-8111-111111111111', revision='0')
    definition_file.write_text(yaml.safe_dump(definition, sort_keys=False, width=120))
    print(f'Normalized {count} target requests; removed disposable generated response examples. Existing collections are outside this script scope.')

if __name__ == '__main__':
    main()
