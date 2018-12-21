const express = require('express');
const router = express.Router();
const MongoClient = require('mongodb').MongoClient;
const ObjectId = require('mongodb').ObjectID;
const config = require('../config');
const request = require('request');
let baseBoosterUrl = 'https://api.magicthegathering.io/v1/sets/{0}/booster';

const requestQueue = [];
let lock = false;

let queueFuncComplete = () => {
  lock = false;
  handleQueue();
};

let handleQueue = (requestFunc, res) => {
  if (requestFunc) {
    requestQueue.push(requestFunc);
  }
  if (!lock && requestQueue.length > 0) {
    lock = true;
    let request = requestQueue[0];
    requestQueue.splice(0, 1);
    try {
      request();
    } catch (error) {
      if (res) {
        send(res);
      } else {
        queueFuncComplete();
      }
    }
  }
};

function send(res, status, data, errorMessage) {
  res.send({ status: status || 500, errorMessage: errorMessage, data: data });
  queueFuncComplete();
}

function createGame(game, playerName, ip, res) {
  MongoClient.connect(config.dbUrl, { useNewUrlParser: true }, (err, database) => {
    if (err) {
      database.close();
      throw err;
    } else {
      let code = new ObjectId();
      let playerId = new ObjectId();
      let db = database.db('draft');

      while (game.sets.length < 3) {
        game.sets.push(game.sets[game.sets.length - 1]);
      }
      if (game.sets.length > 3) {
        game.sets = [game.sets[0], game.sets[1], game.sets[2]];
      }

      game.sets.reverse();
      db.collection('games').insertOne({
        code: code,
        state: 0,
        maxPlayers: game.maxPlayers,
        sets: game.sets,
        players: [{
          id: playerId,
          name: game.name,
          ip: ip,
          currentPack: [],
          backupPacks: [],
          packQueue: [],
          cards: [],
          done: false
        }]
      }, (err) => {
        if (err) {
          send(res);
        } else {
          send(res, 200, { code: code, playerId: playerId });
          populatePacks(code, playerId, game.sets);
        }
        database.close();
      });
    }
  });
}

function joinGame(code, playerName, ip, res) {
  MongoClient.connect(config.dbUrl, { useNewUrlParser: true }, (err, database) => {
    if (err) {
      throw err;
    } else {
      let playerId = new ObjectId();
      let db = database.db('draft');
      db.collection('games').find({
        code: new ObjectId(code)
      }).toArray((err, results) => {
        if (err) {
          send(res);
          database.close();
        } else if (results.length > 0) {
          let result = results[0];
          let match = result.players.filter((player) => player.name === playerName);
          if (match.length > 0) {
            if (match[0].ip === ip) {
              send(res, 200, { code: code, playerId: match[0].id });
            } else {
              send(res, 400, undefined, 'Name taken');
            }
            database.close();
          } else if (result.maxPlayers === result.players.length) {
            send(res, 400, undefined, 'Game is full');
            database.close();
          } else {
            db.collection('games').update({
              code: new ObjectId(code)
            },
            {
              $addToSet: {
                "players": {
                  id: playerId,
                  name: playerName,
                  ip: ip,
                  currentPack: [],
                  backupPacks: [],
                  packQueue: [],
                  cards: [],
                  done: false
                }
              }
            }, (err) => {
              if (err) {
                send(res);
                database.close();
              } else {
                send(res, 200, { code: code, playerId: playerId });
                database.close();
                populatePacks(code, playerId, result.sets);
              }
            });
          }
        } else {
          database.close();
          send(res, 404, undefined, 'Code not recognized.');
        }
      });
    }
  });
}

function startGame(code, res) {
  MongoClient.connect(config.dbUrl, { useNewUrlParser: true }, (err, database) => {
    if (err) {
      throw err;
    } else {
      let db = database.db('draft');
      db.collection('games').update({
        code: new ObjectId(code)
      },
      {
        $set: {
          "state": 1
        }
      }, (err) => {
        if (err) {
          send(res);
        } else {
          send(res, 200);
        }
        database.close();
      });
    }
  });
}

function chooseCard(code, playerId, card, res) {
  MongoClient.connect(config.dbUrl, { useNewUrlParser: true }, (err, database) => {
    if (err) {
      throw err;
    } else {
      let db = database.db('draft');
      db.collection('games').find({ code: new ObjectId(code) }).toArray((err, findResults) => {
        if (err) {
          send(res);
          database.close();
        } else if (findResults.length > 0) {
          let findResult = findResults[0];
          let modified = pickACard(playerId, card, findResult);
          db.collection('games').update({ code: new ObjectId(code) }, modified, (err) => {
            if (err) {
              send(res);
            } else {
              send(res, 200);
            }
            database.close();
          });
        } else {
          send(res, 404, undefined, 'Game not found');
          database.close();
        }
      });
    };
  });
}

function getGameConfig(code, playerId, res) {
  MongoClient.connect(config.dbUrl, { useNewUrlParser: true }, (err, database) => {
    if (err) {
      throw err;
    } else {
      const db = database.db('draft');
      db.collection('games').find({ code: new ObjectId(code) }).toArray((err, results) => {
        if (err) {
          send(res);
          database.close();
          return;
        }
        if (results.length > 0) {
          let result = results[0];
          let playerMatch = result.players.filter(player => player.id.toString() === playerId.toString());
          if (playerMatch.length === 0) {
            send(res, 404, 'Game not found');
          } else {
            send(res, 200, {
              name: playerMatch[0].name,
              maxPlayers: result.maxPlayers,
              sets: result.sets,
              code: code,
              playerId: playerId,
              players: result.players.map(player => player.name),
              cards: playerMatch[0].cards,
              currentPack: playerMatch[0].currentPack,
              state: result.state,
              done: playerMatch[0].done
            });
          }
          database.close();
        } else {
          send(res, 404, undefined, 'Game code not recognized.');
          database.close();
        }
      });
    }
  });
}

function populatePacks(code, playerId, sets) {
  let boosters = [];
  let boosterFulfillment = (data) => {
    if (!data.cards) {
      console.log(data);
      return;
    }
    boosters.push(data.cards.map(item => {
      let name = item.name;
      if (item.names && item.names.length > 1) {
        name = item.names.join(' // ');
      }
      return name.replace(/ \([a-z]\)/, '');
    }));
    if (boosters.length === 3) {
      MongoClient.connect(config.dbUrl, { useNewUrlParser: true }, (err, database) => {
        if (err) {
          throw err;
        }
        const db = database.db('draft');
        db.collection('games').find({ code: new ObjectId(code) }).toArray((err, results) => {
          if (err) {
            throw err;
          } else if (results.length > 0) {
            let result = results[0];
            let playerMatch = result.players.filter(plyr => plyr.id.toString() === playerId.toString());
            if (playerMatch.length > 0) {
              let player = playerMatch[0];
              player.currentPack = boosters[0];
              boosters.splice(0, 1);
              player.backupPacks = boosters;
              db.collection('games').update({ code: new ObjectId(code) }, result, (err) => {
                if (err) {
                  throw err;
                }
                database.close();
              });
            }
          } else {
            database.close();
          }
        });
      });
    }
  };

  for (let set of sets) {
    request.get({
      url: baseBoosterUrl.replace('{0}', set),
      json: true,
      headers: { 'User-Agent': 'request' }
    }, (err, response, data) => {
      if (err) {
        throw err;
      }
      boosterFulfillment(data);
    });
  }
}

function pickACard(playerId, card, game) {
  let player = game.players.filter(plyr => plyr.id.toString() === playerId.toString())[0];

  // fucked up with an additional request
  if (player.currentPack.filter(item => item === card.name).length === 0) {
    return game;
  }

  player.cards.push(card);
  player.currentPack = removeFirst(player.currentPack, (item) => item === card.name);

  let nextPlayerIndex;
  if (player.backupPacks.length === 1) {
    nextPlayerIndex = game.players.indexOf(player) - 1;
    nextPlayerIndex = nextPlayerIndex < 0 ? game.players.length - 1 : nextPlayerIndex;
  } else {
    nextPlayerIndex = game.players.indexOf(player) + 1;
    nextPlayerIndex = nextPlayerIndex > game.players.length - 1 ? 0 : nextPlayerIndex;
  }

  let nextPlayer = game.players[nextPlayerIndex];
  if (player.currentPack.length === 0) {
    if (player.backupPacks.length === 0) {
      player.done = true;
    } else {
      player.currentPack = player.backupPacks[0];
      player.backupPacks.splice(0, 1);
    }
  } else {
    if (nextPlayer.currentPack.length === 0) {
      nextPlayer.currentPack = player.currentPack;
    } else {
      nextPlayer.packQueue.push(player.currentPack);
    }

    player.currentPack = [];
    if (player.packQueue.length > 0) {
      player.currentPack = player.packQueue[0];
      player.packQueue.splice(0, 1);
    }
  }
  return game;
}

function removeFirst(arr, checkFunc) {
  for (let i = 0; i < arr.length; i++) {
    if (checkFunc(arr[i])) {
      arr.splice(i, 1);
      return arr;
    }
  }
  return arr;
}

// Create game
router.post('/game', (req, res) => {
  handleQueue(() => {
    createGame(req.body, req.body.playerName, req.ip, res);
  }, res);
});

// Join game
router.post('/game/:gameId/player', (req, res) => {
  handleQueue(() => {
    joinGame(req.params.gameId, req.body.name, req.ip, res);
  }, res);
});

// Start game
router.put('/game/:gameId', (req, res) => {
  handleQueue(() => {
    startGame(req.params.gameId, res);
  }, res);
});

// Choose card
router.post('/game/:gameId/player/:playerId', (req, res) => {
  handleQueue(() => {
    chooseCard(req.params.gameId, req.params.playerId, req.body.card, res);
  }, res);
})

// Get game state/config
router.get('/game/:gameId/player/:playerId', (req, res) => {
  handleQueue(() => {
    getGameConfig(req.params.gameId, req.params.playerId, res);
  }, res);
});

// Home to test that we're running
router.get('/', (req, res) => {
  res.send({status: 200, message: 'banana'});
});

module.exports = router;
