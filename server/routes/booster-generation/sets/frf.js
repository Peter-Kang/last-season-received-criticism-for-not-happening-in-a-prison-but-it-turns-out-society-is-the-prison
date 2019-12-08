const Utility = require('../utility');

const specialLands = [
  'Bloodfell Caves',
  'Blossoming Sands',
  'Jungle Hollow',
  'Rugged Highlands',
  'Thornwood Falls',
  'Tranquil Cove',
  'Crucible of the Spirit Dragon',
  'Dismal Backwater',
  'Scoured Barrens',
  'Swiftwater Cliffs',
  'Wind-Scarred Crag'
];

function generatePacks(cards, count, _) {
  const boosters = [];

  const lands = cards.filter(card => specialLands.includes(card.name));
  const commons = cards.filter(card => card.rarity === 'common' && !specialLands.includes(card.name));
  const uncommons = cards.filter(card => card.rarity === 'uncommon');

  let rares = cards.filter(card => card.rarity === 'rare');
  rares = rares.concat(rares);
  rares.concat(cards.filter(card => card.rarity === 'mythic'));

  while(boosters.length < count) {
    let booster = [];
    const isFoil = Utility.getRandomIndex(6) === 2;

    for(let i = 0; i < (isFoil ? 10 : 11); i++) {
      booster.push(Utility.getRandomCard(commons, booster));
    }

    for(let i = 0; i < 3; i++) {
      booster.push(Utility.getRandomCard(uncommons, booster));
    }

    booster.push(Utility.getRandomCard(rares, booster));
    if (isFoil) {
      booster.push({
        ...Utility.getRandomCard(cards, booster, false),
        isFoil: true
      });
    }
    booster.push(Utility.getRandomCard(lands, booster, false));

    boosters.push(booster.map(Utility.mapCard));
  }
  return boosters;
}

exports.generatePacks = generatePacks;
