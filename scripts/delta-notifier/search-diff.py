from rdflib import Graph, Dataset
import json
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('left_diff', type=str, nargs=1)
parser.add_argument('right_diff', type=str, nargs=1)
parser.add_argument('delta', type=str, nargs=1)
parser.add_argument('--write', dest='write', type=str, nargs=1)
parser.add_argument('--missing-inserts-file', type=str, nargs=1)
parser.add_argument('--missing-deletes-file', type=str, nargs=1)
parser.set_defaults(write=True)

args = parser.parse_args()
left_diff = args.left_diff[0]
right_diff = args.right_diff[0]
delta_filename = args.delta[0]
write_output = args.write[0].lower() in [
    'true', '1', 't', 'y', 'yes', 'yeah', 'yup'
]
if write_output:
    inserts_output_file = args.missing_inserts_file[0]
    deletes_output_file = args.missing_deletes_file[0]
    if inserts_output_file is None or deletes_output_file is None:
        inserts_output_file = 'missing_inserts.nq'
        deletes_output_file = 'missing_deletes.nq'
        print(
            f"Warning: no output files specified, using {inserts_output_file} and {deletes_output_file}"
        )

left = Dataset()
left.parse(left_diff)
left_diff = set(map(lambda i: tuple(map(str, i[:3])), list(left)))
right = Dataset()
right.parse(right_diff)
right_diff = set(map(lambda i: tuple(map(str, i[:3])), list(right)))

delta_data = []
delta_inserts = set()
delta_deletes = set()
with open(delta_filename) as delta_file:
    delta_data = json.load(delta_file)
for delta_message in delta_data:
    for insert in delta_message['inserts']:
        delta_inserts.add(
            (insert['subject']['value'], insert['predicate']['value'],
             insert['object']['value']))
    for delete in delta_message['deletes']:
        delta_deletes.add(
            (delete['subject']['value'], delete['predicate']['value'],
             delete['object']['value']))

found_inserts = 0
for triple in delta_inserts:
    if triple in left_diff:
        left_diff.remove(triple)
        found_inserts += 1
missing_inserts = len(left_diff)

print(f"Number of diffs found in the inserts: {found_inserts}")
print(f"Total number of missing inserts: {missing_inserts}")

found_deletes = 0
for triple in delta_deletes:
    if triple in right_diff:
        right_diff.remove(triple)
        found_deletes += 1
missing_deletes = len(right_diff)

print(f"Number of diffs found in the deletes: {found_deletes}")
print(f"Total number of missing deletes: {missing_deletes}")

if write_output:
    missing_inserts_dataset = Dataset()
    missing_inserts_dataset.addN(
        filter(lambda i: tuple(map(str, i[:3])) in left_diff, left))
    missing_inserts_dataset.serialize(inserts_output_file, format="nquads")
    print(f"Writing missing inserts to {inserts_output_file}")
    missing_deletes_dataset = Dataset()
    missing_deletes_dataset.addN(
        filter(lambda i: tuple(map(str, i[:3])) in right_diff, right))
    missing_deletes_dataset.serialize(deletes_output_file, format="nquads")
    print(f"Writing missing deletes to {deletes_output_file}")

if missing_inserts + missing_deletes > 0:
    exit(1)
