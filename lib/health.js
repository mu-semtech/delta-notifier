import { app } from 'mu';
import dayjs from 'dayjs';

const FAILURES = [];

FAILURES.recent = function() {
  const now = dayjs.now();
  return this.filter(failure => failure.date.diff(now, 'hours') <= 3);
};

app.get('/health', function(req, res) {
  let recent = FAILURES.recent();
  if (recent.length) {
    return res.status(500, {
      status: 'FAILING',
      failures: recent
    });
  }
  return res.status(200, {
    status: 'UP'
  });
});

export {
  FAILURES
};