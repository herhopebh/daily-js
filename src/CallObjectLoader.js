import { callObjectBundleUrl } from "./utils";

function prepareDailyConfig(callFrameId) {
  // Add a global callFrameId so we can have both iframes and one
  // call object mode calls live at the same time
  if (!window._dailyConfig) {
    window._dailyConfig = {};
  }
  window._dailyConfig.callFrameId = callFrameId;
}

export default class CallObjectLoader {
  constructor() {
    this._currentLoad = null;
  }

  /**
   * Loads the call object bundle (if needed), then invokes the callback
   * function, which takes one boolean argument whose value is true if the
   * load was a no-op.
   *
   * No-op loads can happen when leaving a meeting and then later joining one.
   * Since the call object bundle sets up global state in the same scope as the
   * app code consuming it, it only needs to be loaded and executed once ever.
   *
   * @param meetingOrBaseUrl Meeting URL (like https://somecompany.daily.co/hello)
   *  or base URL (like https://somecompany.daily.co), used to determine where
   *  to load the bundle from.
   * @param callFrameId A string identifying this "call frame", to distinguish it
   *  from other iframe-based calls for message channel purposes.
   * @param successCallback Callback function that takes a wasNoOp argument
   *  (true if call object script was ever loaded once before).
   * @param failureCallback Callback function that takes an error message.
   */
  load(meetingOrBaseUrl, callFrameId, successCallback, failureCallback) {
    if (this.loaded) {
      window._dailyCallObjectSetup(callFrameId);
      successCallback(true); // true = "this load() was a no-op"
      return;
    }

    prepareDailyConfig(callFrameId);

    // Cancel current load, if any
    this._currentLoad && this._currentLoad.cancel();

    // Start a new load
    this._currentLoad = new LoadOperation(
      meetingOrBaseUrl,
      callFrameId,
      successCallback,
      failureCallback
    );
    this._currentLoad.start();
  }

  /**
   * Cancel loading the call object bundle. No callbacks will be invoked.
   */
  cancel() {
    this._currentLoad && this._currentLoad.cancel();
  }

  /**
   * Returns a boolean indicating whether the call object bundle has been
   * loaded and executed.
   */
  get loaded() {
    return this._currentLoad && this._currentLoad.succeeded;
  }
}

const LOAD_ATTEMPTS = 3;
const LOAD_ATTEMPT_DELAY = 3 * 1000;

class LoadOperation {
  constructor(meetingOrBaseUrl, callFrameId, successCallback, failureCallback) {
    this._attemptsRemaining = LOAD_ATTEMPTS;
    this._currentAttempt = null;

    this._meetingOrBaseUrl = meetingOrBaseUrl;
    this._callFrameId = callFrameId;
    this._successCallback = successCallback;
    this._failureCallback = failureCallback;
  }

  start() {
    // Bail if this load has already started
    if (this._currentAttempt) {
      return;
    }

    const retryOrFailureCallback = (errorMessage) => {
      if (this._currentAttempt.cancelled) {
        return;
      }

      if (--this._attemptsRemaining === 0) {
        this._failureCallback(errorMessage);
        return;
      }

      setTimeout(() => {
        if (this._currentAttempt.cancelled) {
          return;
        }
        this._currentAttempt = new LoadAttempt(
          this._meetingOrBaseUrl,
          this._callFrameId,
          this._successCallback,
          retryOrFailureCallback
        );
        this._currentAttempt.start();
      }, LOAD_ATTEMPT_DELAY);
    };

    this._currentAttempt = new LoadAttempt(
      this._meetingOrBaseUrl,
      this._callFrameId,
      this._successCallback,
      retryOrFailureCallback
    );
    this._currentAttempt.start();
  }

  cancel() {
    this._currentAttempt && this._currentAttempt.cancel();
  }

  get cancelled() {
    return this._currentAttempt && this._currentAttempt.cancelled;
  }

  get succeeded() {
    return this._currentAttempt && this._currentAttempt.succeeded;
  }
}

class LoadAttemptAbortedError extends Error {}

const LOAD_ATTEMPT_TIMEOUT = 20 * 1000;

class LoadAttempt {
  constructor(meetingOrBaseUrl, callFrameId, successCallback, failureCallback) {
    this.cancelled = false;
    this.succeeded = false;

    this._timedOut = false;
    this._timeout = null;

    this._meetingOrBaseUrl = meetingOrBaseUrl;
    this._callFrameId = callFrameId;
    this._successCallback = successCallback;
    this._failureCallback = failureCallback;
  }

  start() {
    const url = callObjectBundleUrl(this._meetingOrBaseUrl);

    this._timeout = setTimeout(() => {
      this._timedOut = true;
      this._failureCallback(`Timed out when loading call object bundle ${url}`);
    }, LOAD_ATTEMPT_TIMEOUT);

    fetch(url)
      .then((res) => {
        clearTimeout(this._timeout);
        if (this.cancelled || this._timedOut) {
          throw new LoadAttemptAbortedError();
        }
        if (!res.ok) {
          throw new Error(`Received ${res.status} response`);
        }
        return res.text();
      })
      .then((code) => {
        if (this.cancelled) {
          throw new LoadAttemptAbortedError();
        }
        eval(code);
      })
      .then(() => {
        if (this.cancelled) {
          throw new LoadAttemptAbortedError();
        }
        this.succeeded = true;
        this._successCallback(false); // false = "this load() wasn't a no-op"
      })
      .catch((e) => {
        clearTimeout(this._timeout);
        if (e instanceof LoadAttemptAbortedError) {
          console.log("[LoadAttempt] cancelled");
          return;
        }
        this._failureCallback(`Failed to load call object bundle ${url}: ${e}`);
      });
  }

  cancel() {
    clearTimeout(this._timeout);
    this.cancelled = true;
  }
}
