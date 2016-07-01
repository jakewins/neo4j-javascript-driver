/**
 * Copyright (c) 2002-2016 "Neo Technology,"
 * Network Engine for Objects in Lund AB [http://neotechnology.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import StreamObserver from './internal/stream-observer';
import Result from './result';

/**
 * Represents a transaction in the Neo4j database. This is a powerful class,
 * giving raw access to the {@link #commit()} and {@link rollback()} primitives.
 *
 * However, writing code that safely uses these primitives can be surprisingly hard.
 * Because of this, the Driver provides a second transaction class, {@link LambdaTransaction},
 * which works as syntax sugar on top of this and makes it easier to write safe code.
 *
 * @access public
 */
class Transaction {
  /**
   * @constructor
   * @param {Connection} conn - A connection to use
   * @param {function()} onClose - Function to be called when transaction is committed or rolled back.
   */
  constructor(conn, onClose) {
    this._conn = conn;
    let streamObserver = new _TransactionStreamObserver(this);
    this._conn.run("BEGIN", {}, streamObserver);
    this._conn.discardAll(streamObserver);
    this._state = _states.ACTIVE;
    this._onClose = onClose;
  }

  /**
   * Run Cypher statement
   * Could be called with a statement object i.e.: {statement: "MATCH ...", parameters: {param: 1}}
   * or with the statem ent and parameters as separate arguments.
   * @param {mixed} statement - Cypher statement to execute
   * @param {Object} parameters - Map with parameters to use in statement
   * @return {Result} - New Result
   */
  run(statement, parameters) {
    if(typeof statement === 'object' && statement.text) {
      parameters = statement.parameters || {};
      statement = statement.text;
    }
    return this._state.run(this._conn,  new _TransactionStreamObserver(this), statement, parameters);
  }

  /**
   * Commits the transaction and returns the result.
   *
   * After committing the transaction can no longer be used.
   *
   * @returns {Result} - New Result
   */
  commit() {
    let committed = this._state.commit(this._conn, new _TransactionStreamObserver(this));
    this._state = committed.state;
    //clean up
    this._onClose();
    return committed.result;

  }

  /**
   * Rollbacks the transaction.
   *
   * After rolling back, the transaction can no longer be used.
   *
   * @returns {Result} - New Result
   */
  rollback() {
    let committed = this._state.rollback(this._conn, new _TransactionStreamObserver(this));
    this._state = committed.state;
    //clean up
    this._onClose();
    return committed.result;
  }

  _onError() {
    this._onClose();
    this._state = _states.FAILED;
  }
}

/**
 * Represents a transaction in the Neo4j database. This is syntax-sugar on top of
 * {@link Transaction}, making it easier to write transactional code safely.
 *
 * Unless you understand the difference between this and {@link Transaction}, and
 * know what you are doing, you should use this class over the other.
 *
 * @access public
 */
class LambdaTransaction {
  constructor(tx) {
    this._tx = tx;

    // This always points to the last promise we've made to the client; it is updated each time
    // the user calls `run`
    this._tailPromise = tx;
    this._state = 'schrodinger';

    // Bind success and failure to `this`, so they can be used like
    // tx.run('..').then(tx.success)
    let _success = this.success, _failure = this.failure;
    this.success = () => _success();
    this.failure = (e) => _failure();
  }

  /**
   * Run Cypher statement
   * Could be called with a statement object i.e.: {statement: "MATCH ...", parameters: {param: 1}}
   * or with the statem ent and parameters as separate arguments.
   * @param {mixed} statement - Cypher statement to execute
   * @param {Object} parameters - Map with parameters to use in statement
   * @return {Result} - New Result
   */
  run(statement, parameters) {
    return this._tailPromise = this._tx.run(statement, parameters);
  }

  success() {
    // Only allow marking as successful if there's never been any other state change
    // eg. don't allow success to override a prior call to failure.
    if(this._state === 'schrodinger') {
      this._state = 'alive';
    }
  }

  failure() {
    this._state = 'dead';
  }

  // This should be called to "wrap up", it will append the transaction finalization code to the current
  // tail promise.
  _finish() {
    // The below catch/then construct works the same way `finally` would;
    // the `catch` will catch any error in the promise chain, and the `then`
    // after it will, because of that, always get executed.
    let error = undefined;
    this._tailPromise
      .catch( (e) => {
        error = e;
      })
      .then( () => {
        if(error) {
          this._tx.rollback();
          throw error;
        } else if( this._state !== 'alive' ) {
          return this._tx.rollback();
        } else {
          return this._tx.commit();
        }
      })
  }
}

/** Internal stream observer used for transactional results*/
class _TransactionStreamObserver extends StreamObserver {
  constructor(tx) {
    super();
    this._tx = tx;
    //this is to to avoid multiple calls to onError caused by IGNORED
    this._hasFailed = false;
  }

  onError(error) {
    if (!this._hasFailed) {
      this._tx._onError();
      super.onError(error);
      this._hasFailed = true;
    }
  }
}

/** internal state machine of the transaction*/
let _states = {
  //The transaction is running with no explicit success or failure marked
  ACTIVE: {
    commit: (conn, observer) => {
      return {result: _runDiscardAll("COMMIT", conn, observer),
        state: _states.SUCCEEDED}
    },
    rollback: (conn, observer) => {
      return {result: _runDiscardAll("ROLLBACK", conn, observer), state: _states.ROLLED_BACK};
    },
    run: (conn, observer, statement, parameters) => {
      conn.run( statement, parameters || {}, observer );
      conn.pullAll( observer );
      conn.sync();
      return new Result( observer, statement, parameters );
    }
  },

  //An error has occurred, transaction can no longer be used and no more messages will
  // be sent for this transaction.
  FAILED: {
    commit: (conn, observer) => {
      observer.onError({
        error: "Cannot commit statements in this transaction, because previous statements in the " +
        "transaction has failed and the transaction has been rolled back. Please start a new" +
        " transaction to run another statement."
      });
      return {result: new Result(observer, "COMMIT", {}), state: _states.FAILED};
    },
    rollback: (conn, observer) => {
      observer.onError({error:
      "Cannot rollback transaction, because previous statements in the " +
      "transaction has failed and the transaction has already been rolled back."});
      return {result: new Result(observer, "ROLLBACK", {}), state: _states.FAILED};
    },
    run: (conn, observer, statement, parameters) => {
      observer.onError({error:
      "Cannot run statement, because previous statements in the " +
      "transaction has failed and the transaction has already been rolled back."});
      return new Result(observer, statement, parameters);
    }
  },

  //This transaction has successfully committed
  SUCCEEDED: {
    commit: (conn, observer) => {
      observer.onError({
        error: "Cannot commit statements in this transaction, because commit has already been successfully called on the transaction and transaction has been closed. Please start a new" +
        " transaction to run another statement."
      });
      return {result: new Result(observer, "COMMIT", {}), state: _states.SUCCEEDED};
    },
    rollback: (conn, observer) => {
      observer.onError({error:
        "Cannot rollback transaction, because transaction has already been successfully closed."});
      return {result: new Result(observer, "ROLLBACK", {}), state: _states.SUCCEEDED};
    },
    run: (conn, observer, statement, parameters) => {
      observer.onError({error:
      "Cannot run statement, because transaction has already been successfully closed."});
      return new Result(observer, statement, parameters);
    }
  },

  //This transaction has been rolled back
  ROLLED_BACK: {
    commit: (conn, observer) => {
      observer.onError({
        error: "Cannot commit this transaction, because it has already been rolled back."
      });
      return {result: new Result(observer, "COMMIT", {}), state: _states.ROLLED_BACK};
    },
    rollback: (conn, observer) => {
      observer.onError({error:
        "Cannot rollback transaction, because transaction has already been rolled back."});
      return {result: new Result(observer, "ROLLBACK", {}), state: _states.ROLLED_BACK};
    },
    run: (conn, observer, statement, parameters) => {
      observer.onError({error:
        "Cannot run statement, because transaction has already been rolled back."});
      return new Result(observer, statement, parameters);
    }
  }
};

function _runDiscardAll(msg, conn, observer) {
  conn.run(msg, {}, observer );
  conn.discardAll(observer);
  conn.sync();
  return new Result(observer, msg, {});
}

export default Transaction;
export {Transaction, LambdaTransaction}
