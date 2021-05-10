var _ = require('lodash');

var arr = [{a : 3}, {a: 4}];
var ctx = {b : 5};

var transformed =  _.map(arr, function(obj) {return obj.a + this.b}.bind(ctx));

console.log(transformed.join(', '));
