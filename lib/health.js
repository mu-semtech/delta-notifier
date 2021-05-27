import { app } from 'mu';
import dayjs from 'dayjs';

const FAILURES = [];

FAILURES.recent = function() {
  return this.filter(failure => failure.date.diff(dayjs(), 'hours') <= 3);
};

app.get('/health', function(req, res) {
  let recent = FAILURES.recent();
  if (recent.length) {
    return res.status(500).send({
      status: 'FAILING',
      failures: recent
    });
  }
  return res.status(200).send({
    status: 'UP'
  });
});

export {
  FAILURES
};