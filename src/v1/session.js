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
import {Transaction, LambdaTransaction} from './transaction';
import {newError} from "./error";

/**
  * A Session instance is used for handling the connection and
  * sending statements through the connection.
  * @access public
  */

class Session {
  /**
   * @constructor
   * @param {Connection} conn - A connection to use
   * @param {function()} onClose - Function to be called on connection close
   */
  constructor( conn, onClose ) {
    this._conn = conn;
    this._onClose = onClose;
    this._hasTx = false;
  }

  /**
   * Run Cypher statement
   * Could be called with a statement object i.e.: {statement: "MATCH ...", parameters: {param: 1}}
   * or with the statement and parameters as separate arguments.
   * @param {mixed} statement - Cypher statement to execute
   * @param {Object} parameters - Map with parameters to use in statement
   * @return {Result} - New Result
   */
  run(statement, parameters = {}) {
    if(typeof statement === 'object' && statement.text) {
      parameters = statement.parameters || {};
      statement = statement.text;
    }
    let streamObserver = new StreamObserver();
    if (!this._hasTx) {
      this._conn.run(statement, parameters, streamObserver);
      this._conn.pullAll(streamObserver);
      this._conn.sync();
    } else {
      streamObserver.onError(newError("Statements cannot be run directly on a "
       + "session with an open transaction; either run from within the "
       + "transaction or use a different session."));
    }
    return new Result( streamObserver, statement, parameters );
  }

  /**
   * Begin a new transaction in this session. A session can have at most one transaction running at a time, if you
   * want to run multiple concurrent transactions, you should use multiple concurrent sessions.
   *
   * While a transaction is open the session cannot be used to run statements outside the transaction.
   *
   * @returns {Transaction} - New Transaction
   */
  beginTransaction() {
    if (this._hasTx) {
      throw new newError("You cannot begin a transaction on a session with an "
      + "open transaction; either run from within the transaction or use a "
      + "different session.")
    }

    this._hasTx = true;
    return new Transaction(this._conn, () => {this._hasTx = false});
  }

  /**
   * Execute a group of statements in a transaction. All statements in Neo4j are transactional - meaning if you
   * just `run` a statement on it's own, it will be implicitly wrapped in a transaction. Hence, this method is only
   * useful if you want to run several statements in the <b>same</b> transaction, or if you want to execute business
   * logic after you issue a statement to decide if you want to commit it or not.
   *
   * This method takes a function that describes the work you want to do transactionally. When you are done with whatever
   * operations you want to perform, and want to commit, you should call {@link LambdaTransaction#success()}. This will
   * mark the transaction as successful, and it will automatically be committed.
   *
   * By using this mechanism, if there are any exceptions or other errors anywhere in your code,
   * {@link LambdaTransaction#success()} won't get called, and the transaction will then not be committed.
   *
   * If you want to force a transaction to roll back, simply call {@link LambdaTransaction#failure()}. This will force
   * the transaction to roll back, even if you call `success()` later.
   *
   * @param {function(LambdaTransaction)} unitOfWork - A function that performs the statements you'd like to run, using
   *                                                   the {@link LambdaTransaction transaction} object it is given as
   *                                                   an argument. If you want the transcation to commit, call
   *                                                   `success` on it.
   * @returns {Promise} - Promise that completes when the transaction is committed
   */
  transactionally(unitOfWork) {
    let tx = new LambdaTransaction(this.beginTransaction());
    try {
      unitOfWork(tx);
    } catch(e) {
      // Note: we do not rethrow here; that would force the user to both try/catch *and* .catch() with the promise
      // method. Instead, we normalize all error management through Promise#catch()
      tx._tailPromise.then(Promise.reject(e));
    }
    return tx._finish();
  }

  /**
   * Close this session.
   * @param {function()} cb - Function to be called after the session has been closed
   * @return
   */
  close(cb=(()=>null)) {
    if(this._onClose) {
      try {
        this._onClose(cb);
      } finally {
        this._onClose = null;
      }
    } else {
      cb();
    }
  }
}

export default Session;
