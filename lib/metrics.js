import dayjs from 'dayjs';

class Metrics {

  constructor() {
    this._requests = [];

    // NOTE: set interval to clean up request metrics every hour
    const now = dayjs();
    const nextHour = now.hour(now.hour() + 1).minute(0).second(0).millisecond(0);
    setTimeout(() => {
      this.collectGarbage();
      setInterval(this.collectGarbage.bind(this), 1000 * 60 * 60);
    }, nextHour.diff(now, 's'));
  }

  get requests() {
    const response = this.getLastRequests(3, 'h');
    response['failed'] = response.filter(request => !!request.error);
    return response;
  }

  collectGarbage() {
    console.log('Collecting garbage ...');
    console.log(this._requests);
    // NOTE: we slice to remove any unwanted meta-data (clean-copy)
    this._requests = this.requests.slice();
    console.log('Done');
    console.log(this._requests);
  }

  addRequest(request) {
    request['time'] = dayjs();
    this._requests.push(request);
  }

  getLastRequests(time = 1, unit = 'minute') {
    return this._requests.filter(value => dayjs().diff(value.time, unit) <= time);
  }

  getReport() {
    const report = {
      failed: {
        amount: 0
      }
    };

    console.log(this.requests);
    console.log(this._requests);
    report['total'] = this.requests.length;
    report.failed.amount = this.requests.failed.length;

    const helper = {};
    report.failed.requests = this.requests.failed.reduce((result, request) => {
      const key = `${request.url}-${request.method}`;
      if (!helper[key]) {
        helper[key] = Object.assign({}, {
          url: request.url,
          method: request.method,
          amount: 1
        });
        result.push(helper[key]);
      } else {
        helper[key].amount++;
      }
      return result;
    }, []);

    return report;
  }

}

const metric = new Metrics();

// NOTE: we only expose a singleton for service wide use.
export default metric;