#!/bin/bash
DIFF_FILE=${1:-/project/data/diff_file}
DELTA_FILE=${2:-/project/data/delta_file.json}
WRITE_OUTPUT=${3:-yes}
INSERT_OUTPUT=${4:-/project/data/missing_inserts.nq}
DELETE_OUTPUT=${4:-/project/data/missing_deletes.nq}
left_file=$(mktemp /tmp/diff.XXXXXXXXXX.nq)
right_file=$(mktemp /tmp/diff.XXXXXXXXXX.nq)
cat $DIFF_FILE | egrep "^(>) " | cut -c 3- > $left_file
cat $DIFF_FILE | egrep "^(<) " | cut -c 3- > $right_file

pip install rdflib &> /dev/null

python3 search-diff.py $left_file $right_file $DELTA_FILE --write $WRITE_OUTPUT --missing-inserts-file $INSERT_OUTPUT --missing-deletes-file $DELETE_OUTPUT
