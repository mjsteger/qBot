var EconomyManager = function() {
	this.targetNumBuilders = 5; // number of workers we want building stuff
	this.targetNumFields = 5;
	
	this.resourceMaps = {}; // Contains maps showing the density of wood, stone and metal
	
	this.setCount = 0;  //stops villagers being reassigned to other resources too frequently
};
// More initialisation for stuff that needs the gameState
EconomyManager.prototype.init = function(gameState){
	this.targetNumWorkers = Math.floor(gameState.getPopulationMax()/3);
};

EconomyManager.prototype.trainMoreWorkers = function(gameState, queues) {
	// Count the workers in the world and in progress
	var numWorkers = gameState.countEntitiesAndQueuedWithRole("worker");
	numWorkers += queues.villager.countTotalQueuedUnits();

	// If we have too few, train more
	if (numWorkers < this.targetNumWorkers) {
		for ( var i = 0; i < this.targetNumWorkers - numWorkers; i++) {
			queues.villager.addItem(new UnitTrainingPlan(gameState, "units/{civ}_support_female_citizen", {
				"role" : "worker"
			}));
		}
	}
};

// Pick the resource which most needs another worker
EconomyManager.prototype.pickMostNeededResources = function(gameState) {

	var self = this;

	// Find what resource type we're most in need of
	this.gatherWeights = gameState.ai.queueManager.futureNeeds(gameState);

	var numGatherers = {};
	for ( var type in this.gatherWeights)
		numGatherers[type] = 0;

	gameState.getOwnEntitiesWithRole("worker").forEach(function(ent) {
		if (ent.getMetadata("subrole") === "gatherer")
			numGatherers[ent.getMetadata("gather-type")] += 1;
	});

	var types = Object.keys(this.gatherWeights);
	types.sort(function(a, b) {
		// Prefer fewer gatherers (divided by weight)
		var va = numGatherers[a] / (self.gatherWeights[a]+1);
		var vb = numGatherers[b] / (self.gatherWeights[b]+1);
		return va-vb;
	});

	return types;
};

EconomyManager.prototype.reassignRolelessUnits = function(gameState) {
	//TODO: Move this out of the economic section
	var roleless = gameState.getOwnEntitiesWithRole(undefined);

	roleless.forEach(function(ent) {
		if (ent.hasClass("Worker")){
			ent.setMetadata("role", "worker");
		}else if(ent.hasClass("CitizenSoldier") || ent.hasClass("Super")){
			ent.setMetadata("role", "soldier");
		}else{
			ent.setMetadata("role", "unknown");
		}
	});
};

// If the numbers of workers on the resources is unbalanced then set some of workers to idle so 
// they can be reassigned by reassignIdleWorkers.
EconomyManager.prototype.setWorkersIdleByPriority = function(gameState){
	this.gatherWeights = gameState.ai.queueManager.futureNeeds(gameState);
	
	var numGatherers = {};
	var totalGatherers = 0;
	var totalWeight = 0;
	for ( var type in this.gatherWeights){
		numGatherers[type] = 0;
		totalWeight += this.gatherWeights[type];
	}

	gameState.getOwnEntitiesWithRole("worker").forEach(function(ent) {
		if (ent.getMetadata("subrole") === "gatherer"){
			numGatherers[ent.getMetadata("gather-type")] += 1;
			totalGatherers += 1;
		}
	});

	for ( var type in this.gatherWeights){
		var allocation = Math.floor(totalGatherers * (this.gatherWeights[type]/totalWeight));
		if (allocation < numGatherers[type]){
			var numToTake = numGatherers[type] - allocation;
			gameState.getOwnEntitiesWithRole("worker").forEach(function(ent) {
				if (ent.getMetadata("subrole") === "gatherer" && ent.getMetadata("gather-type") === type && numToTake > 0){
					ent.setMetadata("subrole", "idle");
					numToTake -= 1;
				}
			});
		}
	}
};

EconomyManager.prototype.reassignIdleWorkers = function(gameState) {
	
	var self = this;

	// Search for idle workers, and tell them to gather resources based on demand

	var idleWorkers = gameState.getOwnEntitiesWithRole("worker").filter(function(ent) {
		return (ent.isIdle() || ent.getMetadata("subrole") === "idle");
	});

	if (idleWorkers.length) {
		var resourceSupplies = gameState.findResourceSupplies();

		idleWorkers.forEach(function(ent) {

			var types = self.pickMostNeededResources(gameState);
			for ( var typeKey in types) {
				var type = types[typeKey];
				// Make sure there's actually some of that type
				if (!resourceSupplies[type])
					continue;

				// Pick the closest one.
				// TODO: we should care about distance to dropsites, not
				// (just) to the worker,
				// and gather rates of workers

				var workerPosition = ent.position();
				var supplies = [];
				resourceSupplies[type].forEach(function(supply) {
					// Skip targets that are too hard to hunt
					if (supply.entity.isUnhuntable())
						return;
					
					// And don't go for the bloody fish!
					if (supply.entity.hasClass("SeaCreature"))
						return;

					var dist = VectorDistance(supply.position, workerPosition);

					// Skip targets that are far too far away (e.g. in the
					// enemy base)
					if (dist > 512)
						return;

					supplies.push({
						dist : dist,
						entity : supply.entity
					});
				});

				supplies.sort(function(a, b) {
					// Prefer smaller distances
					if (a.dist != b.dist)
						return a.dist - b.dist;

					return false;
				});

				// Start gathering
				if (supplies.length) {
					ent.gather(supplies[0].entity);
					ent.setMetadata("subrole", "gatherer");
					ent.setMetadata("gather-type", type);
					return;
				}
			}

			// Couldn't find any types to gather
			ent.setMetadata("subrole", "idle");
		});
	}
};

EconomyManager.prototype.assignToFoundations = function(gameState) {
	// If we have some foundations, and we don't have enough
	// builder-workers,
	// try reassigning some other workers who are nearby

	var foundations = gameState.findFoundations();

	// Check if nothing to build
	if (!foundations.length)
		return;

	var workers = gameState.getOwnEntitiesWithRole("worker");

	var builderWorkers = workers.filter(function(ent) {
		return (ent.getMetadata("subrole") === "builder");
	});

	// Check if enough builders
	var extraNeeded = this.targetNumBuilders - builderWorkers.length;
	if (extraNeeded <= 0)
		return;

	// Pick non-builders who are closest to the first foundation,
	// and tell them to start building it

	var target = foundations.toEntityArray()[0];

	var nonBuilderWorkers = workers.filter(function(ent) {
		return (ent.getMetadata("subrole") !== "builder");
	});

	var nearestNonBuilders = nonBuilderWorkers.filterNearest(target.position(), extraNeeded);

	// Order each builder individually, not as a formation
	nearestNonBuilders.forEach(function(ent) {
		ent.repair(target);
		ent.setMetadata("subrole", "builder");
	});
};

EconomyManager.prototype.buildMoreFields = function(gameState, queues) {
	// give time for treasures to be gathered
	if (gameState.getTimeElapsed() < 30 * 1000)
		return;
	var numFields = gameState.countEntitiesAndQueuedWithType(gameState.applyCiv("structures/{civ}_field"));
	numFields += queues.field.totalLength();

	for ( var i = numFields; i < this.targetNumFields; i++) {
		queues.field.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_field"));
	}
};

// If all the CC's are destroyed then build a new one
EconomyManager.prototype.buildNewCC= function(gameState, queues) {
	var numCCs = gameState.countEntitiesAndQueuedWithType(gameState.applyCiv("structures/{civ}_civil_centre"));
	numCCs += queues.civilCentre.totalLength();

	for ( var i = numCCs; i < 1; i++) {
		queues.civilCentre.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_civil_centre"));
	}
};

//creates and maintains a map of tree density
EconomyManager.prototype.updateResourceMaps = function(gameState, events){
	// The weight of the influence function is amountOfResource/decreaseFactor 
	var decreaseFactor = {wood: 15, stone: 100, metal: 100};
	// This is the maximum radius of the influence
	var radius = {wood:13, stone: 10, metal: 10};
	var resources = ["wood", "stone", "metal"];
	
	for (key in resources){
		var resource = resources[key];
		// if there is no resourceMap create one with an influence for everything with that resource
		if (! this.resourceMaps[resource]){
			this.resourceMaps[resource] = new Map(gameState);

			var supplies = gameState.findResourceSupplies();
			for (i in supplies[resource]){
				var current = supplies[resource][i];
				var x = Math.round(current.position[0] / gameState.cellSize);
				var z = Math.round(current.position[1] / gameState.cellSize);
				var strength = Math.round(current.entity.resourceSupplyMax()/decreaseFactor[resource]);
				this.resourceMaps[resource].addInfluence(x, z, radius[resource], strength);
			}
		}
		// Look for destroy events and subtract the entities original influence from the resourceMap
		for (i in events) {
			var e = events[i];

			if (e.type === "Destroy") {
				if (e.msg.rawEntity.template){
					var ent = new Entity(gameState.ai, e.msg.rawEntity);
					if (ent && ent.resourceSupplyType() && ent.resourceSupplyType().generic === resource){
						var x = Math.round(ent.position()[0] / gameState.cellSize);
						var z = Math.round(ent.position()[1] / gameState.cellSize);
						var strength = Math.round(ent.resourceSupplyMax()/decreaseFactor[resource]);
						this.resourceMaps[resource].addInfluence(x, z, radius[resource], -1*strength);
					}
				}
			}
		}
	} 
	
	//this.resourceMaps[resource].dumpIm("tree_density.png");
};

// Returns the position of the best place to build a new dropsite for the specified resource
EconomyManager.prototype.getBestResourceBuildSpot = function(gameState, resource){
	// A map which gives a positive weight for all CCs and adds a negative weight near all dropsites
	var friendlyTiles = new Map(gameState);
	gameState.getOwnEntities().forEach(function(ent) {
		// We want to build near a CC of ours
		if (ent.hasClass("CivCentre")){
			var infl = 90;

			var pos = ent.position();
			var x = Math.round(pos[0] / gameState.cellSize);
			var z = Math.round(pos[1] / gameState.cellSize);
			friendlyTiles.addInfluence(x, z, infl, 0.3 * infl);
		}
		// We don't want multiple dropsites at one spot so add a negative for all dropsites
		if (ent.resourceDropsiteTypes() && ent.resourceDropsiteTypes().indexOf(resource) !== -1){
			var infl = 20;
			
			var pos = ent.position();
			var x = Math.round(pos[0] / gameState.cellSize);
			var z = Math.round(pos[1] / gameState.cellSize);
			
			friendlyTiles.addInfluence(x, z, infl, -100, 'constant');
		}
	});
	
	// Multiply by tree density to get a combination of the two maps
	friendlyTiles.multiply(this.resourceMaps[resource]);
	
	//friendlyTiles.dumpIm("tree_density_fade.png", 10000);
	
	var obstructions = Map.createObstructionMap(gameState);
	obstructions.expandInfluences();
	
	var bestIdx = friendlyTiles.findBestTile(4, obstructions)[0];
	
	// Convert from 1d map pixel coordinates to game engine coordinates
	var x = ((bestIdx % friendlyTiles.width) + 0.5) * gameState.cellSize;
	var z = (Math.floor(bestIdx / friendlyTiles.width) + 0.5) * gameState.cellSize;
	
	return [x,z];
};

//return the number of resource dropsites with an acceptable amount of the resource nearby
EconomyManager.prototype.checkResourceConcentrations = function(gameState, resource){
	//TODO: make these values adaptive 
	var requiredInfluence = {wood: 16000, stone: 300, metal: 300};
	var self = this;
	var count = 0;
	gameState.getOwnEntities().forEach(function(ent) {
		if (ent.resourceDropsiteTypes() && ent.resourceDropsiteTypes().indexOf(resource) !== -1){
			var radius = 14;
			
			var pos = ent.position();
			var x = Math.round(pos[0] / gameState.cellSize);
			var z = Math.round(pos[1] / gameState.cellSize);
			if (self.resourceMaps[resource].sumInfluence(x, z, radius) > requiredInfluence[resource]){
				count ++;
			}
		}
	});
	return count;
};

EconomyManager.prototype.update = function(gameState, queues, events) {
	Engine.ProfileStart("economy update");
	
	this.reassignRolelessUnits(gameState);
	
	this.buildNewCC(gameState,queues);

	Engine.ProfileStart("Train workers and build farms");
	this.trainMoreWorkers(gameState, queues);

	this.buildMoreFields(gameState, queues);
	Engine.ProfileStop();
	
	//Later in the game we want to build stuff faster.
	if (gameState.countEntitiesWithType(gameState.applyCiv("units/{civ}_support_female_citizen")) > 50) {
		this.targetNumBuilders = 10;
	}else{
		this.targetNumBuilders = 5;
	}
	
	Engine.ProfileStart("Update Resource Maps");
	this.updateResourceMaps(gameState, events);
	Engine.ProfileStop();
	
	var resources = ["wood", "stone", "metal"];
	var dropsiteNumbers = {wood: 2, stone: 1, metal: 1};
	
	if (queues.economicBuilding.totalLength() === 0 && 
			gameState.countFoundationsWithType(gameState.applyCiv("structures/{civ}_mill")) === 0 &&
			gameState.countFoundationsWithType(gameState.applyCiv("structures/{civ}_civil_centre")) === 0){ 
			//only ever build one mill/CC at a time
		if (gameState.getTimeElapsed() > 30 * 1000){
			for (key in resources){
				var resource = resources[key];
				if (this.checkResourceConcentrations(gameState, resource) < dropsiteNumbers[resource]){
					var spot = this.getBestResourceBuildSpot(gameState, resource);
					
					var myCivCentres = gameState.getOwnEntities().filter(function(ent) {
						var dx = (spot[0]-ent.position()[0]);
						var dy = (spot[1]-ent.position()[1]);
						var dist2 = dx*dx + dy*dy;
						return (ent.hasClass("CivCentre") && dist2 < 190*190);
					});
					
					if (myCivCentres.length === 0){
						queues.economicBuilding.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_civil_centre", spot));
					}else{
						queues.economicBuilding.addItem(new BuildingConstructionPlan(gameState, "structures/{civ}_mill", spot));
					}
					break;
				}
			}
		}
	}
	
	// TODO: implement a timer based system for this
	this.setCount += 1;
	if (this.setCount >= 20){
		this.setWorkersIdleByPriority(gameState);
		this.setCount = 0;
	}

	this.reassignIdleWorkers(gameState);

	this.assignToFoundations(gameState);

	Engine.ProfileStop();
};
