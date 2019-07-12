// Config start
const SHORTTERM_VIEW_IN_DAYS = 28;
const LONGTERM_VIEW_IN_DAYS = 2 * 365; // 2 years
const MOVING_AVERAGE_IN_DAYS = 28; // 4 weeks
// Config end

const HOUR_IN_MS = 60 * 60 * 1000;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

// Pacific Daylight Savings Time for the start of the day
const DAYSTART_OFFSET_TO_UTC_IN_HOURS = 7;

/* Width of time window for which recent tree status statistics get calculated. */
const shorttermTimedelta = SHORTTERM_VIEW_IN_DAYS * DAY_IN_MS;
const longtermTimedelta = LONGTERM_VIEW_IN_DAYS * DAY_IN_MS;
const averageLength = MOVING_AVERAGE_IN_DAYS * DAY_IN_MS;

const dateFormatter = new Intl.DateTimeFormat('en-US', { hour12: false });
const numberFormatterOneDigit = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const treestatusChangesMap = new Map([
                                       ["try", null],
                                       ["autoland", null],
                                       ["mozilla-inbound", null],
                                     ]);

function UTCDate(epoch) {
  return ((new Date(epoch)).toISOString()).slice(0, -14);
}

function percentFormat(number) {
  return numberFormatterOneDigit.format(number * 100) + " %";
}

class TreeStats {
  constructor() {
    this["open"] = 0;
    this["closed"] = 0;
    this["approval-required"] = 0;
    this.closedReasons = {
                           "checkin-compilation": 0,
                           "checkin-test": 0,
                           "backlog": 0,
                           "infra": 0,
                           "merges": 0,
                           "planned": 0,
                           "other": 0,
                           "unknown": 0,
                           "waiting-for-coverage": 0,
                          };
  }
}

var chartData = {
  labels: [],
  datasets: [
    {
      label: "open",
      backgroundColor: "#39D000",
      data: []
    },
    {
      label: "planned",
      backgroundColor: "#000099",
      data: []
    },
    {
      label: "merges",
      backgroundColor: "#0000DD",
      data: []
    },
    {
      label: "approval-required",
      backgroundColor: "#99DDDD",
      data: []
    },
    {
      label: "waiting-for-coverage",
      backgroundColor: "#DDD666",
      data: []
    },
    {
      label: "backlog",
      backgroundColor: "#DD44BB",
      data: []
    },
    {
      label: "unknown",
      backgroundColor: "#777777",
      data: []
    },
    {
      label: "other",
      backgroundColor: "#4488CC",
      data: []
    },
    {
      label: "infra",
      backgroundColor: "#881166",
      data: []
    },
    {
      label: "checkin-test",
      backgroundColor: "#FF6600",
      data: []
    },
    {
      label: "checkin-compilation",
      backgroundColor: "#DD0000",
      data: []
    },
  ]
};

async function getTreestatusChanges({treename, start=Date.now() - longtermTimedelta - averageLength, end=Date.now()}) {
  let response = await fetch("https://treestatus.mozilla-releng.net/trees/" + treename + "/logs?all=1");
  let responseText = await response.text();
  let statusChanges = [];
  statusChanges.push({reason: "",
                      status: "",
                      tags: [],
                      when: end});
  for (statusChange of (JSON.parse(responseText))["result"]) {
    let statusChangeDate = Date.parse(statusChange["when"]);
    // Convert "approval required" to "approval-required".
    let status = statusChange["status"].replace(" ", "-");
    if (statusChangeDate < end) {
      statusChanges.push({reason: statusChange["reason"],
                          status: status,
                          tags: statusChange["tags"],
                          when: statusChangeDate});
      if (statusChangeDate <= start) {
        break;
      }
    }
  }
  return statusChanges;
}

async function getTreeStats(treename) {
  let timerangeEnd = Date.now();
  let timerangeStart = timerangeEnd - shorttermTimedelta;
  treestatusChangesMap.set(treename, await getTreestatusChanges({treename: treename}));
  let statusChangeNext = timerangeEnd;
  let treeStats = new TreeStats();
  let treestatusChanges = treestatusChangesMap.get(treename);
  for (let i = 1; i < treestatusChanges.length; i++) {
    let status = treestatusChanges[i]["status"];
    let statusLength = statusChangeNext - Math.max(treestatusChanges[i]["when"], timerangeStart);
    if (!treeStats.hasOwnProperty(status)) {
      document.getElementById("warnings-and-errors").textContent += `Warning: Unknown tree status '${status}' in data for tree '${treename}. Data dropped.'\r\n`;
      continue;
    }
    treeStats[status] += statusLength;
    /* Also treat 'approval-required' state like 'closed' because all the
       trees managed here have 'open' as default state. */
    if (status !== "open") {
      /* Multiple closure categories possible, we only use the first one found
         for simplicity. */
      let closedReason = treestatusChanges[i]["tags"].length > 0 ? treestatusChanges[i]["tags"][0] : "unknown";
      if (!treeStats.closedReasons.hasOwnProperty(closedReason)) {
        document.getElementById("warnings-and-errors").textContent += `Warning: Unknown closed reason '${closedReason}' in data for tree '${treename}. Data taken into account for reasons why trees got closed as "unknown" but used as for calculating closure time.'\r\n`;
        closedReason = "unknown";
      }
      treeStats.closedReasons[closedReason] += statusLength;
    }
    if (treestatusChanges[i]["when"] <= timerangeStart) {
      break;
    }
    statusChangeNext = treestatusChanges[i]["when"];
  }

  // Adjust the time of status changes to the timezone used for the output
  for (let treestatusChange of treestatusChanges) {
    treestatusChange["when"] -= DAYSTART_OFFSET_TO_UTC_IN_HOURS * HOUR_IN_MS
  }

  // Calculate data for the long term view which displays trends.
  let daysBack = LONGTERM_VIEW_IN_DAYS + 1 + MOVING_AVERAGE_IN_DAYS;
  /* 2 years shown
     1 day because the data end in the middle of day
     30 days before to start with an average with the first day shown */
  let treeStatsPerDay = new Map();
  timerangeStart -= DAYSTART_OFFSET_TO_UTC_IN_HOURS * HOUR_IN_MS
  timerangeEnd -= DAYSTART_OFFSET_TO_UTC_IN_HOURS * HOUR_IN_MS;
  for (let i = 0; i <= daysBack; i++) {
    // Get YYYY-MM-DD string.
    let dayString = UTCDate(timerangeEnd - i * DAY_IN_MS);
    treeStatsPerDay.set(dayString, new TreeStats());
    let weekDay = (new Date(timerangeEnd - i * DAY_IN_MS)).getDay();
    let isWorkingDay = weekDay > 0 && weekDay < 6;
    treeStatsPerDay.get(dayString)["isWorkingDay"] = isWorkingDay;
  }
  
  timerangeStart = timerangeEnd - longtermTimedelta - averageLength - 1 * DAY_IN_MS;
  statusChangeNext = timerangeEnd;
  let statusChangeNextDay = Math.floor(timerangeEnd / DAY_IN_MS);
  treestatusChanges = treestatusChangesMap.get(treename);
  for (let i = 1; i < treestatusChanges.length; i++) {
    let status = treestatusChanges[i]["status"];
    if (!treeStatsPerDay.get(UTCDate(timerangeEnd)).hasOwnProperty(status)) {
      document.getElementById("warnings-and-errors").textContent += `Warning: Unknown tree status '${status}' in data for tree '${treename}. Data dropped.'\r\n`;
      continue;
    }
    /* Multiple closure categories possible, we only use the first one found
       for simplicity. */
    let closedReason = treestatusChanges[i]["tags"].length > 0 ? treestatusChanges[i]["tags"][0] : "unknown";
    if (!treeStatsPerDay.get(UTCDate(timerangeEnd)).closedReasons.hasOwnProperty(closedReason)) {
      document.getElementById("warnings-and-errors").textContent += `Warning: Unknown closed reason '${closedReason}' in data for tree '${treename}. Data taken into account for reasons why trees got closed as "unknown" but used as for calculating closure time.'\r\n`;
      closedReason = "unknown";
    }
    let statusStart = Math.max(treestatusChanges[i]["when"], timerangeStart);
    let statusStartDay = Math.floor((statusStart) / DAY_IN_MS);
    for (let day = statusStartDay; day <= statusChangeNextDay; day++) {
      let dayStatusStart = (day == statusStartDay) ? statusStart : day * DAY_IN_MS;
      let dayStatusEnd = (day == statusChangeNextDay) ? statusChangeNext : (day + 1) * DAY_IN_MS;
      let dayStatusLength = dayStatusEnd - dayStatusStart;
      treeStatsPerDay.get(UTCDate(dayStatusStart))[status] += dayStatusLength;
      /* Also treat 'approval-required' state like 'closed' because all the
         trees managed here have 'open' as default state. */
      if (status !== "open") {
        treeStatsPerDay.get(UTCDate(dayStatusStart)).closedReasons[closedReason] += dayStatusLength;
      }
    }
    statusChangeNext = treestatusChanges[i]["when"];
    statusChangeNextDay = Math.floor((treestatusChanges[i]["when"]) / DAY_IN_MS);
  }

  let treeStatuses = [];
  for (chartDataSet of chartData.datasets) {
    treeStatuses.push(chartDataSet["label"]);
  }
  for (let i = 0; i <= SHORTTERM_VIEW_IN_DAYS; i++) {
    let dayString = UTCDate(timerangeEnd - i * DAY_IN_MS);
    let treeStatsForDay = treeStatsPerDay.get(dayString);
    chartData.labels.push(dayString);
    for (let chartDataDatasetPos = 0; chartDataDatasetPos < treeStatuses.length; chartDataDatasetPos++) {
      let treeStatus = treeStatuses[chartDataDatasetPos];
      switch (treeStatus) {
        case "open":
        case "approval-required":
          chartData.datasets[chartDataDatasetPos].data.push(treeStatsForDay[treeStatus]);
          break;
        default:
          chartData.datasets[chartDataDatasetPos].data.push(treeStatsForDay.closedReasons[treeStatus]);
      }
    }
  }
  chartData.labels.reverse();
  for (let chartDataSet of chartData.datasets) {
    chartDataSet.data.reverse();
    for (let i = 0; i < chartDataSet.data.length; i++) {
        // Convert status times to hours
        chartDataSet.data[i] = Math.round(chartDataSet.data[i] / (1000 * 60 * 60) * 100) / 100;
    }
  }

  let ctx = document.getElementById('by-day-stats').getContext('2d');
  window.shorttermChart = new Chart(ctx, {
    type: 'bar',
    data: chartData,
    options: {
      title: {
        display: true,
        text: 'Tree closure statistics by day [hours]'
      },
      tooltips: {
        mode: 'index',
        intersect: false
      },
      responsive: true,
      scales: {
        xAxes: [{
          stacked: true,
        }],
        yAxes: [{
          stacked: true,
          ticks: {
            min: 0,
            max: 24
          },
        }]
      }
    }
  });

  let treeStatsPerDayAvgAccum = new Map();
  for (let i = 0; i <= LONGTERM_VIEW_IN_DAYS; i++) {
    let dayString = UTCDate(timerangeEnd - i * DAY_IN_MS);
    treeStatsPerDayAvgAccum.set(dayString, new TreeStats());
  }
  for (let i = 0; i <= daysBack; i++) { // ignore incomplete, oldest day
    let dayString = UTCDate(timerangeEnd - i * DAY_IN_MS);
    let treeStatsForDay = treeStatsPerDay.get(dayString);
    // Only interested in working days (Monday to Friday).
    if (!treeStatsForDay["isWorkingDay"]) {
      continue;
    }
    for (let avgDayUsingDataDay = 0; avgDayUsingDataDay < MOVING_AVERAGE_IN_DAYS; avgDayUsingDataDay++) {
      if (i - avgDayUsingDataDay < 0) {
        // It's the future.
        break;
      }
      if (i - avgDayUsingDataDay > LONGTERM_VIEW_IN_DAYS) {
        // Too far in the past. A day before the start of the chart, only used calculating the average.
        continue;
      }
      let avgDayUsingDataDayString = UTCDate(timerangeEnd - (i - avgDayUsingDataDay) * DAY_IN_MS);
      for (let [statusKey, statusValue] of Object.entries(treeStatsForDay)) {
        if (typeof statusValue === "number") {
          treeStatsPerDayAvgAccum.get(avgDayUsingDataDayString)[statusKey] += statusValue;
        }
      }
      for (let [closedReasonKey, closedReasonValue] of Object.entries(treeStatsForDay.closedReasons)) {
        treeStatsPerDayAvgAccum.get(avgDayUsingDataDayString).closedReasons[closedReasonKey] += closedReasonValue;
      }
    }
  }
  for (let i = 0; i <= LONGTERM_VIEW_IN_DAYS; i++) { // ignore incomplete, oldest day
    let dayString = UTCDate(timerangeEnd - i * DAY_IN_MS);
    let treeStatsForDay = treeStatsPerDayAvgAccum.get(dayString);
    let timeTotal = treeStatsForDay["open"] + treeStatsForDay["closed"] + treeStatsForDay["approval-required"];
    for (let [statusKey, statusValue] of Object.entries(treeStatsForDay)) {
      if (typeof statusValue === "number") {
        treeStatsForDay[statusKey] = Math.round(1000 * statusValue / timeTotal) / 10;
      }
    }
    for (let [closedReasonKey, closedReasonValue] of Object.entries(treeStatsForDay.closedReasons)) {
      treeStatsForDay.closedReasons[closedReasonKey] += Math.round(1000 * closedReasonValue / timeTotal) / 10;
    }
  }
  let openSet = [];
  let closedSet = [];
  for (let i = 0; i <= LONGTERM_VIEW_IN_DAYS; i++) { // ignore incomplete, oldest day
    let dayString = UTCDate(timerangeEnd - i * DAY_IN_MS);
    let treeStatsForDay = treeStatsPerDayAvgAccum.get(dayString);
    openSet.push({x: dayString, y: treeStatsForDay["open"]});
    closedSet.push({x: dayString, y: treeStatsForDay["closed"] + treeStatsForDay["approval-required"]});
  }
  ctx = document.getElementById(`longterm-chart-${treename}`);
  let myLineChart = new Chart(ctx, {
      type: "line",
      data: {
              label: "Open [%]",
              datasets: [{
                data: openSet,
                label: "share open [%]",
              }],
      },
      options: {
        scales: {
          xAxes: [{
            type: "time",
          }]
        },
        title: {
          display: true,
          text: 'autoland tree open in % [average for 4 week] for the last 2 years for working days [Monday to Friday]'
        },
      }
    });
}

//getTreeStats("try");
getTreeStats("autoland");
//getTreeStats("mozilla-inbound");
