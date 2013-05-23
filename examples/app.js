var ADL = require('../../jugglingdb').ADL;
var adl = new ADL();
// define models
var Post = adl.define('Post', {
    title:     { type: String, length: 255 },
    content:   { type: ADL.Text },
    date:      { type: Date,    default: function () { return new Date;} },
    timestamp: { type: Number,  default: Date.now },
    published: { type: Boolean, default: false, index: true }
});

// simplier way to describe model
var User = adl.define('User', {
    name:         String,
    bio:          ADL.Text,
    approved:     Boolean,
    joinedAt:     Date,
    age:          Number
});

var Group = adl.define('Group', {name: String});

// define any custom method
User.prototype.getNameAndAge = function () {
    return this.name + ', ' + this.age;
};

var user = new User({name: 'Joe'});
console.log(user);

console.log(adl.models);
console.log(adl.definitions);



